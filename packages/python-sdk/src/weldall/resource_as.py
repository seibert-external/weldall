"""Resource authorization-server access-token helpers."""

from __future__ import annotations

import time
import uuid
from collections.abc import Mapping, Sequence
from typing import Any, NotRequired, TypedDict, overload

from .crypto import is_sha256_jwk_thumbprint
from .errors import WeldallAuthError
from .identity import has_verified_email
from .jwt import sign_es256, verify_es256
from .scope import parse_scope
from .types import JWK, JWTPayload


class IssueAccessTokenInput(TypedDict):
    issuer: str
    subject: str
    email: str
    resource: str
    client_id: str
    scopes: Sequence[str]
    jkt: str
    kid: str
    private_jwk: JWK
    now: NotRequired[int]


class VerifyAccessTokenInput(TypedDict):
    kid: str
    public_jwk: JWK
    issuer: str
    resource: str
    client_id: str
    required_scopes: NotRequired[Sequence[str]]


@overload
def issue_access_token(input: IssueAccessTokenInput, /) -> str: ...


@overload
def issue_access_token(
    *,
    issuer: str,
    subject: str,
    email: str,
    resource: str,
    client_id: str,
    scopes: Sequence[str],
    jkt: str,
    kid: str,
    private_jwk: JWK,
    now: int | None = None,
) -> str: ...


def issue_access_token(input: Mapping[str, Any] | None = None, **kwargs: Any) -> str:
    values = dict(input or {})
    values.update(kwargs)
    now_value = values.get("now")
    now = int(time.time()) if now_value is None else now_value
    scope = " ".join(sorted(set(values["scopes"])))
    if (
        not values["subject"]
        or not has_verified_email({"email": values["email"], "email_verified": True})
        or not is_sha256_jwk_thumbprint(values["jkt"])
        or parse_scope(scope) is None
    ):
        raise ValueError("invalid access-token issuance claims")
    return sign_es256(
        {
            "iss": values["issuer"],
            "sub": values["subject"],
            "email": values["email"],
            "email_verified": True,
            "aud": values["resource"],
            "client_id": values["client_id"],
            "scope": scope,
            "cnf": {"jkt": values["jkt"]},
            "jti": str(uuid.uuid4()),
            "iat": now,
            "exp": now + 600,
        },
        kid=values["kid"],
        private_jwk=values["private_jwk"],
        typ="at+jwt",
    )


@overload
def verify_access_token(token: str, input: VerifyAccessTokenInput, /) -> JWTPayload: ...


@overload
def verify_access_token(
    token: str,
    *,
    kid: str,
    public_jwk: JWK,
    issuer: str,
    resource: str,
    client_id: str,
    required_scopes: Sequence[str] | None = None,
) -> JWTPayload: ...


def verify_access_token(
    token: str, input: Mapping[str, Any] | None = None, **kwargs: Any
) -> JWTPayload:
    values = dict(input or {})
    values.update(kwargs)
    payload = verify_es256(
        token,
        kid=values["kid"],
        public_jwk=values["public_jwk"],
        issuer=values["issuer"],
        audience=values["resource"],
        typ="at+jwt",
        max_token_age_s=600,
        error_code="invalid_token",
        error_status=401,
    )
    cnf = payload.get("cnf")
    granted = parse_scope(payload.get("scope"))
    if (
        payload.get("aud") != values["resource"]
        or not isinstance(cnf, dict)
        or not is_sha256_jwk_thumbprint(cnf.get("jkt"))
        or not isinstance(payload.get("sub"), str)
        or not payload["sub"]
        or not has_verified_email(payload)
        or payload.get("client_id") != values["client_id"]
        or not isinstance(payload.get("jti"), str)
        or not 1 <= len(payload["jti"]) <= 128
        or type(payload.get("iat")) is not int
        or type(payload.get("exp")) is not int
        or payload["exp"] <= payload["iat"]
        or payload["exp"] - payload["iat"] > 600
        or granted is None
    ):
        raise WeldallAuthError("invalid_token", "invalid access token claims", 401)
    required: Sequence[str] | None = values.get("required_scopes")
    if required and any(scope not in granted for scope in required):
        raise WeldallAuthError(
            "insufficient_scope", "required scope is missing", 403, list(required)
        )
    return payload
