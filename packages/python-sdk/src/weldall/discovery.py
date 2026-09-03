"""Authorization-server metadata and rotating JWKS discovery."""

from __future__ import annotations

import json
import math
import threading
import time
from typing import Any

import httpx

from ._url import ParsedUrl, has_credentials, parse_absolute, serialize
from .crypto import assert_public_p256
from .errors import WeldallAuthError
from .jwt import decode_protected_header
from .types import JWK

_JWKS_TTL_SECONDS = 60.0
_UNKNOWN_REFRESH_SECONDS = 5.0
_MAX_BODY = 256_000


class WeldallDiscovery:
    """Synchronous, thread-safe discovery with shared in-flight results and failures."""

    def __init__(
        self,
        issuer: str,
        fetch_origin: str,
        timeout_ms: int = 5_000,
        *,
        http_client: httpx.Client | None = None,
    ) -> None:
        self.issuer = issuer
        self.fetch_origin = fetch_origin.rstrip("/")
        self.timeout_ms = timeout_ms
        self._client = http_client or httpx.Client(
            timeout=timeout_ms / 1000,
            follow_redirects=False,
        )
        self._owns_client = http_client is None
        self._metadata: dict[str, str] | None = None
        self._keys: dict[str, JWK] = {}
        self._jwks_expires_at = 0.0
        self._unknown_refresh_at = 0.0
        self._condition = threading.Condition()
        self._metadata_loading = False
        self._metadata_error: WeldallAuthError | None = None
        self._jwks_loading = False
        self._jwks_error: WeldallAuthError | None = None

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def ready(self) -> None:
        self._refresh_jwks(False)

    def get_key(self, token: str, refresh_for_validation_failure: bool = False) -> tuple[str, JWK]:
        return self.get_signing_key(token, "oauth-id-jag+jwt", refresh_for_validation_failure)

    def get_signing_key(
        self,
        token: str,
        expected_type: str,
        refresh_for_validation_failure: bool = False,
    ) -> tuple[str, JWK]:
        try:
            header = decode_protected_header(token)
            if (
                header.get("alg") != "ES256"
                or header.get("typ") != expected_type
                or "crit" in header
            ):
                raise ValueError("header")
            kid = header.get("kid")
        except Exception as error:
            raise WeldallAuthError("invalid_grant", "invalid signed assertion header") from error
        if not isinstance(kid, str) or not kid:
            raise WeldallAuthError("invalid_grant", "invalid signed assertion header")
        self._refresh_jwks(False)
        with self._condition:
            jwk = self._keys.get(kid)
        if refresh_for_validation_failure or jwk is None:
            self._refresh_jwks(True, throttled=True)
            with self._condition:
                jwk = self._keys.get(kid)
        if jwk is None:
            raise WeldallAuthError("invalid_grant", "unknown Weldall signing key")
        return kid, dict(jwk)

    def _discover(self) -> dict[str, str]:
        with self._condition:
            if self._metadata is not None:
                return dict(self._metadata)
            if self._metadata_loading:
                while self._metadata_loading:
                    self._condition.wait()
                if self._metadata is not None:
                    return dict(self._metadata)
                assert self._metadata_error is not None
                raise _copy_error(self._metadata_error)
            self._metadata_loading = True
            self._metadata_error = None

        metadata: dict[str, str] | None = None
        failure: WeldallAuthError | None = None
        try:
            value = self._fetch_json(f"{self.fetch_origin}/.well-known/oauth-authorization-server")
            if not isinstance(value, dict):
                raise ValueError("invalid metadata")
            issuer = value.get("issuer")
            jwks_uri = value.get("jwks_uri")
            if issuer != self.issuer or not isinstance(jwks_uri, str):
                raise ValueError("issuer mismatch")
            parsed = parse_absolute(jwks_uri, "jwks_uri")
            canonical = serialize(parsed)
            if (
                _origin(parsed) != self.issuer
                or has_credentials(parsed)
                or bool(parsed.query)
                or bool(parsed.fragment)
            ):
                raise ValueError("unsafe jwks_uri")
            metadata = {"issuer": issuer, "jwks_uri": canonical}
        except Exception as error:
            failure = WeldallAuthError("temporarily_unavailable", "Weldall discovery failed", 503)
            failure.__cause__ = error
        finally:
            with self._condition:
                if metadata is not None:
                    self._metadata = metadata
                self._metadata_error = failure
                self._metadata_loading = False
                self._condition.notify_all()
        if failure is not None:
            raise failure
        assert metadata is not None
        return dict(metadata)

    def _refresh_jwks(self, force: bool, *, throttled: bool = False) -> None:
        with self._condition:
            if self._jwks_loading:
                while self._jwks_loading:
                    self._condition.wait()
                if self._jwks_error is not None:
                    raise _copy_error(self._jwks_error)
                return
            now = time.monotonic()
            if not force and self._keys and now < self._jwks_expires_at:
                return
            if throttled:
                if now < self._unknown_refresh_at:
                    return
                self._unknown_refresh_at = now + _UNKNOWN_REFRESH_SECONDS
            self._jwks_loading = True
            self._jwks_error = None

        next_keys: dict[str, JWK] | None = None
        failure: WeldallAuthError | None = None
        try:
            metadata = self._discover()
            parsed = parse_absolute(metadata["jwks_uri"], "jwks_uri")
            value = self._fetch_json(f"{self.fetch_origin}{parsed.path}")
            if not isinstance(value, dict):
                raise ValueError("invalid JWKS")
            keys = value.get("keys")
            if not isinstance(keys, list) or not 1 <= len(keys) <= 20:
                raise ValueError("invalid JWKS size")
            next_keys = {}
            for candidate in keys:
                if not isinstance(candidate, dict):
                    raise ValueError("invalid JWK")
                kid = candidate.get("kid")
                if not isinstance(kid, str) or not kid or kid in next_keys:
                    raise ValueError("invalid JWK kid")
                assert_public_p256(candidate)
                next_keys[kid] = dict(candidate)
        except WeldallAuthError as error:
            failure = error
        except Exception as error:
            failure = WeldallAuthError("temporarily_unavailable", "Weldall JWKS fetch failed", 503)
            failure.__cause__ = error
        finally:
            with self._condition:
                if next_keys is not None:
                    self._keys = next_keys
                    self._jwks_expires_at = time.monotonic() + _JWKS_TTL_SECONDS
                self._jwks_error = failure
                self._jwks_loading = False
                self._condition.notify_all()
        if failure is not None:
            raise failure

    def _fetch_json(self, url: str) -> Any:
        with self._client.stream("GET", url, headers={"accept": "application/json"}) as response:
            response.raise_for_status()
            content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if content_type not in {"application/json", "application/jwk-set+json"}:
                raise ValueError("unexpected content type")
            declared = response.headers.get("content-length")
            if declared is not None:
                try:
                    length = float(declared)
                except ValueError:
                    length = math.nan
                if math.isfinite(length) and length > _MAX_BODY:
                    raise ValueError("response too large")
            chunks: list[bytes] = []
            size = 0
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > _MAX_BODY:
                    raise ValueError("response too large")
                chunks.append(chunk)
        return json.loads(b"".join(chunks).decode("utf-8", errors="strict"))


def _origin(parsed: ParsedUrl) -> str:
    return serialize(parsed, path="", query="", fragment="").rstrip("/")


def _copy_error(error: WeldallAuthError) -> WeldallAuthError:
    return WeldallAuthError(
        error.code,
        error.message,
        error.status,
        error.required_scopes,
        error.reason,
    )
