"""Machine client assertion and DPoP-bound token request helpers."""

from __future__ import annotations

import re
import time
import uuid
from collections.abc import Mapping, Sequence
from typing import Any, Literal, NotRequired, TypedDict, overload

import httpx

from ._url import has_credentials, is_loopback, parse_absolute, serialize
from .constants import (
    MACHINE_TOKEN_LIFETIME_SECONDS,
    MACHINE_TOKEN_TYP,
    PRIVATE_KEY_JWT_ASSERTION_TYPE,
)
from .dpop import create_dpop_proof
from .errors import WeldallAuthError
from .jwt import sign_es256
from .types import JWK

_SCOPE = re.compile(r"^[\x21\x23-\x5b\x5d-\x7e]+$")
_CLIENT = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


class MachineKey(TypedDict):
    private_jwk: JWK
    public_jwk: JWK


class MachineClientAssertionInput(TypedDict):
    client_id: str
    token_endpoint: str
    kid: str
    private_jwk: JWK
    now: NotRequired[int]
    jti: NotRequired[str]


class MachineTokenRequestInput(TypedDict):
    issuer: str
    client_id: str
    kid: str
    key: MachineKey
    resource: str
    scopes: Sequence[str]
    token_endpoint: NotRequired[str]
    http_client: NotRequired[httpx.Client]


class MachineToken(TypedDict):
    access_token: str
    token_type: Literal["DPoP"]
    expires_in: Literal[300]
    scope: str


def _unique_tokens(values: Sequence[str], label: str) -> list[str]:
    if (
        not isinstance(values, (list, tuple))
        or any(not isinstance(value, str) or _SCOPE.fullmatch(value) is None for value in values)
        or len(set(values)) != len(values)
    ):
        raise TypeError(f"{label} must contain unique valid OAuth tokens")
    return list(values)


def _absolute_url(value: str, label: str, origin_only: bool) -> str:
    parsed = parse_absolute(value, label)
    if parsed.scheme.lower() != "https" and not (
        parsed.scheme.lower() == "http" and is_loopback(parsed)
    ):
        raise TypeError(f"{label} must use HTTPS")
    if (
        has_credentials(parsed)
        or bool(parsed.fragment)
        or bool(parsed.query)
        or (origin_only and parsed.path not in ("", "/"))
    ):
        raise TypeError(f"{label} must be an origin without credentials, path, query, or fragment")
    return serialize(parsed)


@overload
def create_machine_client_assertion(input: MachineClientAssertionInput, /) -> str: ...


@overload
def create_machine_client_assertion(
    *,
    client_id: str,
    token_endpoint: str,
    kid: str,
    private_jwk: JWK,
    now: int | None = None,
    jti: str | None = None,
) -> str: ...


def create_machine_client_assertion(input: Mapping[str, Any] | None = None, **kwargs: Any) -> str:
    values = dict(input or {})
    values.update(kwargs)
    client_id = values["client_id"]
    kid = values["kid"]
    if not isinstance(client_id, str) or _CLIENT.fullmatch(client_id) is None:
        raise TypeError("invalid machine client ID")
    if not isinstance(kid, str) or _CLIENT.fullmatch(kid) is None:
        raise TypeError("invalid machine key ID")
    endpoint = _absolute_url(values["token_endpoint"], "tokenEndpoint", False)
    now_value = values.get("now")
    now = int(time.time()) if now_value is None else now_value
    return sign_es256(
        {
            "iss": client_id,
            "sub": client_id,
            "aud": endpoint,
            "iat": now,
            "exp": now + 60,
            "jti": str(uuid.uuid4()) if values.get("jti") is None else values["jti"],
        },
        kid=kid,
        private_jwk=values["private_jwk"],
        typ="JWT",
    )


@overload
def request_machine_token(input: MachineTokenRequestInput, /) -> MachineToken: ...


@overload
def request_machine_token(
    *,
    issuer: str,
    client_id: str,
    kid: str,
    key: MachineKey,
    resource: str,
    scopes: Sequence[str],
    token_endpoint: str | None = None,
    http_client: httpx.Client | None = None,
) -> MachineToken: ...


def request_machine_token(input: Mapping[str, Any] | None = None, **kwargs: Any) -> MachineToken:
    values = dict(input or {})
    values.update(kwargs)
    issuer_url = _absolute_url(values["issuer"], "issuer", True)
    issuer = issuer_url.rstrip("/")
    token_endpoint = _absolute_url(
        values.get("token_endpoint") or f"{issuer}/api/auth/oauth2/token",
        "tokenEndpoint",
        False,
    )
    scopes = _unique_tokens(values["scopes"], "scopes")
    if not scopes:
        raise TypeError("at least one scope is required")
    resource = _absolute_url(values["resource"], "resource", False)
    key = values["key"]
    assertion = create_machine_client_assertion(
        client_id=values["client_id"],
        token_endpoint=token_endpoint,
        kid=values["kid"],
        private_jwk=key["private_jwk"],
    )
    proof = create_dpop_proof(
        private_jwk=key["private_jwk"],
        public_jwk=key["public_jwk"],
        method="POST",
        url=token_endpoint,
    )
    client = values.get("http_client")
    owns_client = client is None
    if client is None:
        client = httpx.Client(follow_redirects=False)
    try:
        response = client.post(
            token_endpoint,
            headers={
                "content-type": "application/x-www-form-urlencoded",
                "dpop": proof,
            },
            data={
                "grant_type": "client_credentials",
                "client_id": values["client_id"],
                "client_assertion_type": PRIVATE_KEY_JWT_ASSERTION_TYPE,
                "client_assertion": assertion,
                "resource": resource,
                "scope": " ".join(scopes),
            },
        )
        try:
            body = response.json()
        except Exception:
            body = None
        if not response.is_success:
            code = body.get("error") if isinstance(body, dict) else None
            raise WeldallAuthError(
                code if isinstance(code, str) else "server_error",
                "machine token request rejected",
                response.status_code,
            )
        if (
            not isinstance(body, dict)
            or not isinstance(body.get("access_token"), str)
            or body.get("token_type") != "DPoP"
            or body.get("expires_in") != MACHINE_TOKEN_LIFETIME_SECONDS
            or not isinstance(body.get("scope"), str)
        ):
            raise WeldallAuthError("server_error", "invalid machine token response", 500)
        return {
            "access_token": body["access_token"],
            "token_type": "DPoP",
            "expires_in": 300,
            "scope": body["scope"],
        }
    finally:
        if owns_client:
            client.close()


__all__ = [
    "MACHINE_TOKEN_LIFETIME_SECONDS",
    "MACHINE_TOKEN_TYP",
    "PRIVATE_KEY_JWT_ASSERTION_TYPE",
    "MachineClientAssertionInput",
    "MachineKey",
    "MachineToken",
    "MachineTokenRequestInput",
    "create_machine_client_assertion",
    "request_machine_token",
]
