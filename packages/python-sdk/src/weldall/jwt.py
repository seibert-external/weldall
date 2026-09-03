"""Compact ES256 JWT signing and explicit claim validation."""

from __future__ import annotations

import base64
import json
import math
import time
from collections.abc import Mapping
from typing import Any, NotRequired, TypedDict, overload

from joserfc import jwt
from joserfc.jwk import ECKey

from .crypto import validate_es256_key_pair
from .errors import WeldallAuthError
from .types import JWK, JWTPayload


class JwtSigningInput(TypedDict):
    kid: str
    private_jwk: JWK
    typ: NotRequired[str]


class JwtVerificationInput(TypedDict):
    kid: str
    public_jwk: JWK
    issuer: str
    audience: str
    typ: NotRequired[str]
    max_token_age_s: NotRequired[int | float]
    error_code: NotRequired[str]
    error_status: NotRequired[int]


def _decode_segment(value: str) -> bytes:
    if not value:
        raise ValueError("empty JWT segment")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON number: {value}")


def _decode_object(segment: str, label: str) -> dict[str, Any]:
    value = json.loads(_decode_segment(segment), parse_constant=_reject_json_constant)
    if not isinstance(value, dict):
        raise ValueError(f"invalid {label}")
    return value


def decode_protected_header(token: str) -> dict[str, Any]:
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("invalid compact JWT")
    return _decode_object(parts[0], "protected header")


def decode_jwt(token: str) -> JWTPayload:
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("invalid compact JWT")
    return _decode_object(parts[1], "JWT payload")


def _numeric_date(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("invalid NumericDate")
    return float(value)


def _validate_registered_times(
    payload: Mapping[str, Any],
    *,
    now: int,
    tolerance: int,
    require_exp: bool,
    require_iat: bool,
    max_age: float | None = None,
) -> None:
    if require_exp and "exp" not in payload:
        raise ValueError("missing exp")
    if require_iat and "iat" not in payload:
        raise ValueError("missing iat")
    if "nbf" in payload and _numeric_date(payload["nbf"]) > now + tolerance:
        raise ValueError("not active")
    if "exp" in payload and _numeric_date(payload["exp"]) <= now - tolerance:
        raise ValueError("expired")
    if "iat" in payload:
        issued_at = _numeric_date(payload["iat"])
        if max_age is not None:
            age = now - issued_at
            if age - tolerance > max_age or age < -tolerance:
                raise ValueError("token age")


@overload
def sign_es256(payload: Mapping[str, Any], key: JwtSigningInput, /) -> str: ...


@overload
def sign_es256(
    payload: Mapping[str, Any],
    *,
    kid: str,
    private_jwk: JWK,
    typ: str = "JWT",
) -> str: ...


def sign_es256(
    payload: Mapping[str, Any],
    key: Mapping[str, Any] | None = None,
    **kwargs: Any,
) -> str:
    values = dict(key or {})
    values.update(kwargs)
    kid = values["kid"]
    private_jwk = values["private_jwk"]
    typ = values.get("typ", "JWT")
    return jwt.encode(
        {"alg": "ES256", "kid": kid, "typ": typ},
        dict(payload),
        ECKey.import_key(private_jwk),
        algorithms=["ES256"],
        default_type=None,
    )


def _audience_matches(value: object, audience: str) -> bool:
    return value == audience or (
        isinstance(value, list)
        and all(isinstance(item, str) for item in value)
        and audience in value
    )


@overload
def verify_es256(token: str, input: JwtVerificationInput, /) -> JWTPayload: ...


@overload
def verify_es256(
    token: str,
    *,
    kid: str,
    public_jwk: JWK,
    issuer: str,
    audience: str,
    typ: str = "JWT",
    max_token_age_s: int | float | None = None,
    error_code: str = "invalid_grant",
    error_status: int = ...,
) -> JWTPayload: ...


def verify_es256(
    token: str,
    input: Mapping[str, Any] | None = None,
    **kwargs: Any,
) -> JWTPayload:
    values = dict(input or {})
    values.update(kwargs)
    code = str(values.get("error_code", "invalid_grant"))
    status = int(values.get("error_status", 401 if code == "invalid_token" else 400))
    try:
        jwt.decode(
            token,
            ECKey.import_key(values["public_jwk"]),
            algorithms=["ES256"],
        )
        header = decode_protected_header(token)
        payload = decode_jwt(token)
        required = ("iss", "aud", "exp", "iat")
        if any(name not in payload for name in required):
            raise ValueError("missing required claim")
        if payload["iss"] != values["issuer"] or not _audience_matches(
            payload["aud"], values["audience"]
        ):
            raise ValueError("issuer or audience")
        max_age_value = values.get("max_token_age_s")
        max_age = None if max_age_value is None else float(max_age_value)
        _validate_registered_times(
            payload,
            now=math.floor(time.time()),
            tolerance=5,
            require_exp=True,
            require_iat=True,
            max_age=max_age,
        )
        if (
            header.get("kid") != values["kid"]
            or header.get("typ") != values.get("typ", "JWT")
            or "crit" in header
        ):
            raise ValueError("header")
        return payload
    except Exception as error:
        if isinstance(error, WeldallAuthError):
            raise
        raise WeldallAuthError(code, "token validation failed", status) from error


def parse_jwk_env(name: str, value: str | None) -> JWK:
    if not value:
        raise ValueError(f"{name} is required")
    try:
        parsed = json.loads(value)
    except Exception as error:
        raise ValueError(f"{name} must be JSON") from error
    if not isinstance(parsed, dict):
        raise ValueError(f"{name} must be JSON")
    return parsed


def load_es256_key_pair_from_env(
    private_name: str,
    private_value: str | None,
    public_name: str,
    public_value: str | None,
) -> tuple[JWK, JWK]:
    return validate_es256_key_pair(
        parse_jwk_env(private_name, private_value),
        parse_jwk_env(public_name, public_value),
    )
