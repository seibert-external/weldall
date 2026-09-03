"""Identity Assertion Authorization Grant issuance and verification."""

from __future__ import annotations

import time
import uuid
from collections.abc import Mapping, Sequence
from typing import Any, NotRequired, TypedDict, cast, overload

from .constants import ID_JAG_DRAFT
from .crypto import is_sha256_jwk_thumbprint
from .errors import WeldallAuthError
from .identity import has_verified_email
from .jwt import sign_es256, verify_es256
from .scope import parse_scope
from .types import JWK, IdJagClaims, JWTPayload


class IssueIdJagInput(TypedDict):
    issuer: str
    subject: str
    email: str
    audience: str
    client_id: str
    resource: str
    scopes: Sequence[str]
    jkt: str
    kid: str
    private_jwk: JWK
    now: NotRequired[int]


class VerifyIdJagInput(TypedDict):
    kid: str
    public_jwk: JWK
    issuer: str
    audience: str
    resource: str
    client_id: str
    allowed_scopes: Sequence[str]


@overload
def issue_id_jag(input: IssueIdJagInput, /) -> str: ...


@overload
def issue_id_jag(
    *,
    issuer: str,
    subject: str,
    email: str,
    audience: str,
    client_id: str,
    resource: str,
    scopes: Sequence[str],
    jkt: str,
    kid: str,
    private_jwk: JWK,
    now: int | None = None,
) -> str: ...


def issue_id_jag(input: Mapping[str, Any] | None = None, **kwargs: Any) -> str:
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
        raise ValueError("invalid ID-JAG issuance claims")
    claims: JWTPayload = {
        "iss": values["issuer"],
        "sub": values["subject"],
        "email": values["email"],
        "email_verified": True,
        "aud": values["audience"],
        "client_id": values["client_id"],
        "resource": values["resource"],
        "scope": scope,
        "cnf": {"jkt": values["jkt"]},
        "jti": str(uuid.uuid4()),
        "iat": now,
        "exp": now + 300,
        "urn:weldall:id-jag-draft": ID_JAG_DRAFT,
    }
    return sign_es256(
        claims,
        kid=values["kid"],
        private_jwk=values["private_jwk"],
        typ="oauth-id-jag+jwt",
    )


@overload
def verify_id_jag(input_token: str, input: VerifyIdJagInput, /) -> IdJagClaims: ...


@overload
def verify_id_jag(
    input_token: str,
    *,
    kid: str,
    public_jwk: JWK,
    issuer: str,
    audience: str,
    resource: str,
    client_id: str,
    allowed_scopes: Sequence[str],
) -> IdJagClaims: ...


def verify_id_jag(
    input_token: str, input: Mapping[str, Any] | None = None, **kwargs: Any
) -> IdJagClaims:
    values = dict(input or {})
    values.update(kwargs)
    payload = verify_es256(
        input_token,
        kid=values["kid"],
        public_jwk=values["public_jwk"],
        issuer=values["issuer"],
        audience=values["audience"],
        typ="oauth-id-jag+jwt",
        max_token_age_s=300,
    )
    cnf = payload.get("cnf")
    scopes = parse_scope(payload.get("scope"))
    if (
        payload.get("aud") != values["audience"]
        or payload.get("resource") != values["resource"]
        or payload.get("client_id") != values["client_id"]
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
        or payload.get("urn:weldall:id-jag-draft") != ID_JAG_DRAFT
        or scopes is None
    ):
        raise WeldallAuthError("invalid_grant", "invalid ID-JAG claims")
    allowed: Sequence[str] = values["allowed_scopes"]
    if any(scope not in allowed for scope in scopes):
        raise WeldallAuthError("invalid_scope")
    return cast(IdJagClaims, payload)
