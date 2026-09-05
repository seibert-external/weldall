"""Synchronous framework-neutral Weldall resource-server core."""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC
from typing import Any, Protocol, cast
from urllib.parse import parse_qsl, urlsplit

from joserfc import jwt
from joserfc.jwk import ECKey

from ._url import has_credentials, is_loopback, parse_absolute, serialize
from .constants import JWT_DPOP_DRAFT, JWT_DPOP_GRANT, MACHINE_TOKEN_LIFETIME_SECONDS
from .crypto import is_sha256_jwk_thumbprint
from .discovery import WeldallDiscovery
from .dpop import verify_strict_dpop
from .errors import WeldallAuthError, oauth_error_response
from .http import Request, Response
from .identity import has_verified_email
from .jwt import (
    _validate_registered_times,
    decode_jwt,
    decode_protected_header,
)
from .machine import MACHINE_TOKEN_TYP
from .replay import consume_replay
from .scope import parse_scope
from .signing import (
    assert_signing_config,
    create_signing_provider,
    sign_with_provider,
    validated_jwks,
)
from .skills import SKILL_ASSERTION_TYPE, SKILL_CATALOG_PATH, load_skill_catalog
from .types import (
    AuthContext,
    MachineAuthContext,
    MachinePrincipal,
    ScopePolicy,
    UserAuthContext,
    UserPrincipal,
    VerifyFailure,
    VerifyResult,
    VerifySuccess,
    WeldallOptions,
)

_SCOPE_CHARS = set(chr(value) for value in [0x21, *range(0x23, 0x5C), *range(0x5D, 0x7F)])
_MACHINE_CLIENT_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-")


def _unique_scopes(values: object, label: str) -> list[str]:
    if (
        not isinstance(values, (list, tuple))
        or any(
            not isinstance(value, str)
            or not value
            or any(char not in _SCOPE_CHARS for char in value)
            for value in values
        )
        or len(set(values)) != len(values)
    ):
        raise TypeError(f"{label} must contain unique valid OAuth scope tokens")
    return list(values)


def _parse_url(
    value: object,
    label: str,
    origin_only: bool,
    allow_insecure_loopback: bool,
) -> str:
    try:
        parsed = parse_absolute(value, label)  # type: ignore[arg-type]
    except TypeError as error:
        raise TypeError(f"{label} must be an absolute URL") from error
    scheme = parsed.scheme.lower()
    if scheme != "https" and not (
        allow_insecure_loopback and scheme == "http" and is_loopback(parsed)
    ):
        raise TypeError(f"{label} must use HTTPS")
    if (
        has_credentials(parsed)
        or bool(parsed.fragment)
        or (origin_only and (parsed.path not in ("", "/") or bool(parsed.query)))
    ):
        raise TypeError(f"{label} must be an origin without credentials, path, query, or fragment")
    return serialize(parsed)


def _origin(value: str) -> str:
    parsed = parse_absolute(value)
    return serialize(parsed, path="", query="", fragment="").rstrip("/")


def _audience_matches(value: object, audience: str) -> bool:
    return value == audience or (
        isinstance(value, list)
        and all(isinstance(item, str) for item in value)
        and audience in value
    )


def _verify_signed(
    token: str,
    jwk: dict[str, Any],
    *,
    issuer: str,
    audience: str,
    required_claims: Sequence[str],
    max_age: int,
    expected_kid: str,
) -> dict[str, Any]:
    jwt.decode(token, ECKey.import_key(jwk), algorithms=["ES256"])
    header = decode_protected_header(token)
    payload = decode_jwt(token)
    if header.get("kid") != expected_kid:
        raise ValueError("kid")
    if any(name not in payload for name in required_claims):
        raise ValueError("missing claim")
    if payload.get("iss") != issuer or not _audience_matches(payload.get("aud"), audience):
        raise ValueError("issuer or audience")
    _validate_registered_times(
        payload,
        now=int(time.time()),
        tolerance=5,
        require_exp=True,
        require_iat=True,
        max_age=max_age,
    )
    return payload


def _get(value: object, key: str, default: Any = None) -> Any:
    return value.get(key, default) if isinstance(value, Mapping) else getattr(value, key, default)


class _MetadataHandler(Protocol):
    def __call__(self, request: Request | None = None) -> Response: ...


@dataclass(frozen=True, slots=True)
class WeldallHandlers:
    token: Callable[[Request], Response]
    authorization_server_metadata: _MetadataHandler
    protected_resource_metadata: _MetadataHandler
    jwks: _MetadataHandler
    skills: Callable[[Request], Response]


class Weldall:
    def __init__(self, host: str, options: WeldallOptions) -> None:
        if not isinstance(host, str) or not host:
            raise TypeError("Weldall host is required")
        if not isinstance(options, Mapping):
            raise TypeError("Weldall options are required")
        allow_insecure = options.get("allow_insecure_loopback") is True
        host_url = _parse_url(host, "Weldall host", True, allow_insecure)
        proxy_value = options.get("discovery_proxy_origin")
        proxy_url = (
            host_url
            if proxy_value is None
            else _parse_url(proxy_value, "discoveryProxyOrigin", True, allow_insecure)
        )
        public_origin_url = _parse_url(
            options.get("public_origin"), "publicOrigin", True, allow_insecure
        )
        resource_url = _parse_url(options.get("resource"), "resource", False, allow_insecure)
        if urlsplit(resource_url).query:
            raise TypeError("resource must not contain a query")
        client_id = options.get("client_id")
        if not isinstance(client_id, str) or not client_id.strip():
            raise TypeError("clientId is required")
        supported_scopes = _unique_scopes(options.get("supported_scopes"), "supportedScopes")
        timeout = options.get("discovery_timeout_ms", 5_000)
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, int)
            or not 100 <= timeout <= 30_000
        ):
            raise TypeError("discoveryTimeoutMs must be an integer between 100 and 30000")
        replay = options.get("replay_store")
        if replay != "disabled" and not callable(_get(replay, "consume")):
            raise TypeError("replayStore is required")
        skills = options.get("skills")
        if skills is not None:
            items = _get(skills, "items", None)
            loader = _get(skills, "load", None)
            has_items = isinstance(items, (list, tuple))
            has_loader = callable(loader)
            if has_items == has_loader:
                raise TypeError("skills must configure exactly one of items or load")
            if replay == "disabled":
                raise TypeError("skill publication requires replay protection")
        signing_key = options["signing_key"]
        assert_signing_config(signing_key)

        self.host = _origin(host_url)
        self.issuer = _origin(public_origin_url)
        self.resource = resource_url
        self.client_id = client_id
        self.supported_scopes = tuple(supported_scopes)
        self.replay_store = replay
        self.signing = create_signing_provider(signing_key)
        self.discovery = WeldallDiscovery(
            self.host,
            _origin(proxy_url),
            timeout,
            http_client=cast(Any, options).get("_http_client"),
        )
        self.token_endpoint = f"{self.issuer}/oauth/token"
        self.skills_endpoint = f"{self.issuer}{SKILL_CATALOG_PATH}" if skills is not None else None
        self._skills_provider = skills
        self.handlers = WeldallHandlers(
            token=self.token_endpoint_handler,
            authorization_server_metadata=cast(
                _MetadataHandler, self.authorization_server_metadata
            ),
            protected_resource_metadata=cast(_MetadataHandler, self.protected_resource_metadata),
            jwks=cast(_MetadataHandler, self.jwks),
            skills=self.skills,
        )

    def close(self) -> None:
        self.discovery.close()

    def ready(self) -> None:
        self.discovery.ready()
        validated_jwks(self.signing)

    def _verify_id_jag_assertion(self, assertion: str) -> dict[str, Any]:
        def validate(refresh: bool) -> dict[str, Any]:
            kid, jwk = self.discovery.get_key(assertion, refresh)
            return _verify_signed(
                assertion,
                jwk,
                issuer=self.host,
                audience=self.issuer,
                required_claims=(
                    "iss",
                    "sub",
                    "email",
                    "email_verified",
                    "aud",
                    "exp",
                    "iat",
                    "jti",
                ),
                max_age=300,
                expected_kid=kid,
            )

        try:
            payload = validate(False)
        except WeldallAuthError:
            raise
        except Exception:
            try:
                payload = validate(True)
            except WeldallAuthError as error:
                if error.code == "temporarily_unavailable":
                    raise
                raise WeldallAuthError("invalid_grant", "ID-JAG validation failed") from error
            except Exception as error:
                raise WeldallAuthError("invalid_grant", "ID-JAG validation failed") from error
        scopes = parse_scope(payload.get("scope"))
        cnf = payload.get("cnf")
        if (
            payload.get("aud") != self.issuer
            or payload.get("resource") != self.resource
            or payload.get("client_id") != self.client_id
            or not isinstance(payload.get("sub"), str)
            or not payload["sub"]
            or not has_verified_email(payload)
            or not isinstance(payload.get("jti"), str)
            or not 1 <= len(payload["jti"]) <= 128
            or type(payload.get("iat")) is not int
            or type(payload.get("exp")) is not int
            or payload["exp"] <= payload["iat"]
            or payload["exp"] - payload["iat"] > 300
            or not isinstance(cnf, dict)
            or not is_sha256_jwk_thumbprint(cnf.get("jkt"))
            or payload.get("urn:weldall:id-jag-draft")
            != "draft-ietf-oauth-identity-assertion-authz-grant-04"
            or scopes is None
        ):
            raise WeldallAuthError("invalid_grant", "invalid ID-JAG claims")
        if any(scope not in self.supported_scopes for scope in scopes):
            raise WeldallAuthError("invalid_scope", "ID-JAG requested an unsupported scope")
        return payload

    def _verify_skill_assertion(self, assertion: str) -> dict[str, Any]:
        skills_endpoint = self.skills_endpoint
        if skills_endpoint is None:
            raise WeldallAuthError("invalid_token", "skill publication is disabled", 401)

        def validate(refresh: bool) -> dict[str, Any]:
            kid, jwk = self.discovery.get_signing_key(assertion, SKILL_ASSERTION_TYPE, refresh)
            return _verify_signed(
                assertion,
                jwk,
                issuer=self.host,
                audience=skills_endpoint,
                required_claims=(
                    "iss",
                    "sub",
                    "aud",
                    "resource",
                    "purpose",
                    "exp",
                    "iat",
                    "jti",
                ),
                max_age=60,
                expected_kid=kid,
            )

        try:
            payload = validate(False)
        except WeldallAuthError as first:
            if first.code == "temporarily_unavailable":
                raise
            try:
                payload = validate(True)
            except WeldallAuthError as error:
                if error.code == "temporarily_unavailable":
                    raise
                raise WeldallAuthError(
                    "invalid_token", "skill assertion validation failed", 401
                ) from error
            except Exception as error:
                raise WeldallAuthError(
                    "invalid_token", "skill assertion validation failed", 401
                ) from error
        except Exception:
            try:
                payload = validate(True)
            except WeldallAuthError as error:
                if error.code == "temporarily_unavailable":
                    raise
                raise WeldallAuthError(
                    "invalid_token", "skill assertion validation failed", 401
                ) from error
            except Exception as error:
                raise WeldallAuthError(
                    "invalid_token", "skill assertion validation failed", 401
                ) from error
        if (
            payload.get("iss") != self.host
            or payload.get("sub") != self.host
            or payload.get("aud") != skills_endpoint
            or payload.get("resource") != self.resource
            or payload.get("purpose") != "skills:read"
            or not isinstance(payload.get("jti"), str)
            or not 1 <= len(payload["jti"]) <= 128
            or type(payload.get("iat")) is not int
            or type(payload.get("exp")) is not int
            or payload["exp"] <= payload["iat"]
            or payload["exp"] - payload["iat"] > 60
        ):
            raise WeldallAuthError("invalid_token", "invalid skill assertion claims", 401)
        consume_replay(
            self.replay_store,
            "skills",
            payload["jti"],
            _timestamp(payload["exp"] + 6),
            {
                "code": "invalid_token",
                "message": "skill assertion was already used",
                "status": 401,
            },
        )
        return payload

    def skills(self, request: Request) -> Response:
        if self._skills_provider is None:
            return Response.empty(status=404)
        try:
            if request.method != "GET":
                return Response.empty(status=405, headers={"allow": "GET"})
            authorization = request.headers.get("authorization")
            assertion = _single_authorization(authorization, "Bearer")
            if assertion is None:
                raise WeldallAuthError(
                    "invalid_token", "exactly one Bearer assertion is required", 401
                )
            self._verify_skill_assertion(assertion)
            catalog = load_skill_catalog(self._skills_provider, self.resource)
            return Response.json(catalog, headers={"cache-control": "private, no-store"})
        except WeldallAuthError as error:
            return oauth_error_response(error)
        except Exception:
            return Response.json(
                {
                    "error": "temporarily_unavailable",
                    "error_description": "Skill catalog unavailable",
                },
                status=503,
                headers={"cache-control": "no-store"},
            )

    def token_endpoint_handler(self, request: Request) -> Response:
        try:
            if request.method != "POST":
                raise WeldallAuthError("invalid_request", "token endpoint requires POST")
            media_type = (
                (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
            )
            if media_type != "application/x-www-form-urlencoded":
                raise WeldallAuthError("invalid_request", "form content type required")
            raw = request.text()
            if _js_len(raw) > 64_000:
                raise WeldallAuthError("invalid_request", "form is too large")
            pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=False)
            names = [name for name, _value in pairs]
            if (
                any(name not in {"grant_type", "assertion"} for name in names)
                or names.count("grant_type") != 1
                or names.count("assertion") != 1
            ):
                raise WeldallAuthError("invalid_request", "invalid or duplicate OAuth parameter")
            form = dict(pairs)
            if form["grant_type"] != JWT_DPOP_GRANT:
                raise WeldallAuthError("unsupported_grant_type")
            assertion = form["assertion"]
            proof = request.headers.get("dpop")
            if not proof or "," in proof:
                raise WeldallAuthError("invalid_dpop_proof", "exactly one DPoP proof is required")
            jag = self._verify_id_jag_assertion(assertion)
            verify_strict_dpop(
                proof,
                method="POST",
                url=self.token_endpoint,
                replay=self.replay_store,
                expected_jkt=jag["cnf"]["jkt"],
            )
            consume_replay(
                self.replay_store,
                "id-jag",
                jag["jti"],
                _timestamp(jag["exp"] + 6),
                {"code": "invalid_grant", "message": "ID-JAG was already used"},
            )
            now = int(time.time())
            payload = {
                "iss": self.issuer,
                "sub": jag["sub"],
                "email": jag["email"],
                "email_verified": True,
                "aud": self.resource,
                "client_id": self.client_id,
                "scope": jag["scope"],
                "cnf": {"jkt": jag["cnf"]["jkt"]},
                "jti": str(uuid.uuid4()),
                "iat": now,
                "exp": now + 600,
            }
            access_token = sign_with_provider(self.signing, payload, "at+jwt")
            return Response.json(
                {
                    "access_token": access_token,
                    "token_type": "DPoP",
                    "expires_in": 600,
                    "scope": jag["scope"],
                },
                headers={"cache-control": "no-store", "pragma": "no-cache"},
            )
        except Exception as error:
            return oauth_error_response(error)

    def _verify_user_token(self, access_token: str) -> dict[str, Any]:
        try:
            keys = validated_jwks(self.signing)
            header = decode_protected_header(access_token)
            if (
                header.get("alg") != "ES256"
                or header.get("typ") != "at+jwt"
                or "crit" in header
                or not isinstance(header.get("kid"), str)
            ):
                raise ValueError("invalid header")
            key = next((candidate for candidate in keys if candidate["kid"] == header["kid"]), None)
            if key is None:
                raise ValueError("unknown kid")
            return _verify_signed(
                access_token,
                key,
                issuer=self.issuer,
                audience=self.resource,
                required_claims=(
                    "iss",
                    "sub",
                    "email",
                    "email_verified",
                    "aud",
                    "exp",
                    "iat",
                    "jti",
                ),
                max_age=600,
                expected_kid=header["kid"],
            )
        except WeldallAuthError:
            raise
        except Exception as error:
            raise WeldallAuthError(
                "invalid_token", "access token validation failed", 401
            ) from error

    def _verify_machine_token(self, access_token: str) -> dict[str, Any]:
        def validate(refresh: bool) -> dict[str, Any]:
            kid, jwk = self.discovery.get_signing_key(access_token, MACHINE_TOKEN_TYP, refresh)
            return _verify_signed(
                access_token,
                jwk,
                issuer=self.host,
                audience=self.resource,
                required_claims=("iss", "sub", "aud", "exp", "iat", "jti"),
                max_age=300,
                expected_kid=kid,
            )

        try:
            return validate(False)
        except WeldallAuthError as first:
            if first.code == "temporarily_unavailable":
                raise
        except Exception:
            pass
        try:
            return validate(True)
        except WeldallAuthError as error:
            if error.code == "temporarily_unavailable":
                raise
            raise WeldallAuthError(
                "invalid_token", "machine token validation failed", 401
            ) from error
        except Exception as error:
            raise WeldallAuthError(
                "invalid_token", "machine token validation failed", 401
            ) from error

    def verify(self, request: Request, policy: ScopePolicy | None = None) -> AuthContext:
        policy = policy or {}
        required = _unique_scopes(policy.get("scopes", []), "policy.scopes")
        any_scopes = _unique_scopes(policy.get("any_scopes", []), "policy.anyScopes")
        access_token = _single_authorization(request.headers.get("authorization"), "DPoP")
        proof = request.headers.get("dpop")
        if access_token is None or not proof or "," in proof:
            raise WeldallAuthError("invalid_token", "DPoP authorization required", 401)
        try:
            header = decode_protected_header(access_token)
            if header.get("typ") == "at+jwt":
                profile = "user"
            elif header.get("typ") == MACHINE_TOKEN_TYP:
                profile = "machine"
            else:
                raise ValueError("unsupported typ")
        except Exception as error:
            raise WeldallAuthError(
                "invalid_token", "unsupported access token profile", 401
            ) from error
        payload = (
            self._verify_user_token(access_token)
            if profile == "user"
            else self._verify_machine_token(access_token)
        )
        granted = parse_scope(payload.get("scope"))
        cnf = payload.get("cnf")
        subject = payload.get("sub")
        if profile == "user":
            profile_valid = (
                payload.get("client_id") == self.client_id
                and has_verified_email(payload)
                and isinstance(subject, str)
                and not subject.startswith("machine:")
                and "identity_type" not in payload
                and "token_type" not in payload
            )
        else:
            machine_client_id = payload.get("client_id")
            profile_valid = (
                isinstance(machine_client_id, str)
                and 1 <= len(machine_client_id) <= 128
                and all(char in _MACHINE_CLIENT_CHARS for char in machine_client_id)
                and subject == f"machine:{machine_client_id}"
                and payload.get("azp") == machine_client_id
                and payload.get("identity_type") == "machine"
                and payload.get("token_type") == "machine"
                and "email" not in payload
                and "email_verified" not in payload
            )
        lifetime = 600 if profile == "user" else MACHINE_TOKEN_LIFETIME_SECONDS
        if (
            payload.get("aud") != self.resource
            or not isinstance(subject, str)
            or not subject
            or not profile_valid
            or not isinstance(payload.get("jti"), str)
            or not 1 <= len(payload["jti"]) <= 128
            or type(payload.get("iat")) is not int
            or type(payload.get("exp")) is not int
            or payload["exp"] <= payload["iat"]
            or payload["exp"] - payload["iat"] > lifetime
            or granted is None
            or any(scope not in self.supported_scopes for scope in granted)
            or not isinstance(cnf, dict)
            or not is_sha256_jwk_thumbprint(cnf.get("jkt"))
        ):
            raise WeldallAuthError("invalid_token", "invalid access token claims", 401)
        incoming = parse_absolute(request.url, "request URL")
        public = parse_absolute(self.issuer, "public origin")
        public_url = serialize(
            public,
            path=incoming.path,
            query=incoming.query,
            fragment="",
        )
        try:
            verify_strict_dpop(
                proof,
                method=request.method,
                url=public_url,
                replay=self.replay_store,
                access_token=access_token,
                expected_jkt=cnf["jkt"],
            )
        except WeldallAuthError as error:
            if error.code == "invalid_dpop_proof":
                raise WeldallAuthError(
                    error.code, error.message, 401, reason=error.reason
                ) from error
            raise
        missing_all = [scope for scope in required if scope not in granted]
        if missing_all or (any_scopes and not any(scope in granted for scope in any_scopes)):
            raise WeldallAuthError(
                "insufficient_scope",
                "required scope is missing",
                403,
                [*required, *any_scopes],
            )
        if profile == "machine":
            machine_client_id = payload["client_id"]
            return MachineAuthContext(
                identity_type="machine",
                identity=MachinePrincipal(
                    type="machine", subject=subject, client_id=machine_client_id
                ),
                subject=subject,
                client_id=machine_client_id,
                scopes=tuple(granted),
                token_id=payload["jti"],
            )
        return UserAuthContext(
            identity_type="user",
            identity=UserPrincipal(
                type="user",
                subject=subject,
                email=payload["email"],
                email_verified=True,
            ),
            subject=subject,
            email=payload["email"],
            email_verified=True,
            client_id=self.client_id,
            scopes=tuple(granted),
            token_id=payload["jti"],
        )

    def verify_no_throw(self, request: Request, policy: ScopePolicy | None = None) -> VerifyResult:
        try:
            return VerifySuccess(ok=True, auth=self.verify(request, policy))
        except Exception as error:
            known = (
                error
                if isinstance(error, WeldallAuthError)
                else WeldallAuthError("invalid_token", "request rejected", 401)
            )
            return VerifyFailure(
                ok=False,
                error=known,
                response=oauth_error_response(known),
            )

    def authorization_server_metadata(self, _request: Request | None = None) -> Response:
        return Response.json(
            {
                "issuer": self.issuer,
                "token_endpoint": self.token_endpoint,
                "jwks_uri": f"{self.issuer}/.well-known/jwks.json",
                "grant_types_supported": [JWT_DPOP_GRANT],
                "response_types_supported": [],
                "token_endpoint_auth_methods_supported": ["none"],
                "dpop_signing_alg_values_supported": ["ES256"],
                "urn:weldall:jwt-dpop-draft": JWT_DPOP_DRAFT,
            }
        )

    def protected_resource_metadata(self, _request: Request | None = None) -> Response:
        value: dict[str, Any] = {
            "resource": self.resource,
            "authorization_servers": [self.issuer],
            "scopes_supported": list(self.supported_scopes),
            "bearer_methods_supported": ["header"],
            "dpop_signing_alg_values_supported": ["ES256"],
        }
        if self.skills_endpoint is not None:
            value["weldall_skills_endpoint"] = self.skills_endpoint
        return Response.json(value)

    def jwks(self, _request: Request | None = None) -> Response:
        return Response.json({"keys": validated_jwks(self.signing)})


def _js_len(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _single_authorization(value: str | None, scheme: str) -> str | None:
    prefix = f"{scheme} "
    if value is None or not value.startswith(prefix) or "," in value:
        return None
    token = value[len(prefix) :]
    if not token or any(char.isspace() for char in token):
        return None
    return token


def _timestamp(value: int):  # type: ignore[no-untyped-def]
    from datetime import datetime

    return datetime.fromtimestamp(value, UTC)


def init_weldall(host: str, options: WeldallOptions) -> Weldall:
    return Weldall(host, options)
