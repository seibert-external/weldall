"""RFC 9449 DPoP proof creation and strict verification."""

from __future__ import annotations

import time
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, NotRequired, TypedDict, overload

from joserfc import jwt
from joserfc.jwk import ECKey

from ._url import has_credentials, is_loopback, parse_absolute, serialize
from .constants import DPOP_FUTURE_SKEW_SECONDS, DPOP_MAX_AGE_SECONDS
from .crypto import assert_public_p256, base64url_sha256, calculate_jwk_thumbprint, safe_equal
from .errors import WeldallAuthError
from .jwt import _validate_registered_times, decode_jwt, decode_protected_header
from .replay import consume_replay
from .types import JWK, Replay, VerifiedDpop


class CreateDpopProofInput(TypedDict):
    private_jwk: JWK
    public_jwk: JWK
    method: str
    url: str
    access_token: NotRequired[str]
    now: NotRequired[int]
    jti: NotRequired[str]


class VerifyStrictDpopInput(TypedDict):
    method: str
    url: str
    replay: Replay
    access_token: NotRequired[str]
    expected_jkt: NotRequired[str]
    now: NotRequired[int]


def normalize_htu(value: str) -> str:
    try:
        parsed = parse_absolute(value, "htu")
    except TypeError as error:
        raise WeldallAuthError("invalid_dpop_proof", "invalid htu scheme") from error
    scheme = parsed.scheme.lower()
    if scheme != "https" and not (scheme == "http" and is_loopback(parsed)):
        raise WeldallAuthError("invalid_dpop_proof", "invalid htu scheme")
    if has_credentials(parsed):
        raise WeldallAuthError("invalid_dpop_proof", "htu must not contain credentials")
    return serialize(parsed, query="", fragment="")


@overload
def create_dpop_proof(input: CreateDpopProofInput, /) -> str: ...


@overload
def create_dpop_proof(
    *,
    private_jwk: JWK,
    public_jwk: JWK,
    method: str,
    url: str,
    access_token: str | None = None,
    now: int | None = None,
    jti: str | None = None,
) -> str: ...


def create_dpop_proof(
    input: Mapping[str, Any] | None = None,
    **kwargs: Any,
) -> str:
    values = dict(input or {})
    values.update(kwargs)
    now = values.get("now")
    issued_at = int(time.time()) if now is None else now
    payload: dict[str, Any] = {
        "htm": str(values["method"]).upper(),
        "htu": normalize_htu(values["url"]),
        "iat": issued_at,
        "jti": str(uuid.uuid4()) if values.get("jti") is None else values["jti"],
    }
    if values.get("access_token"):
        payload["ath"] = base64url_sha256(values["access_token"])
    return jwt.encode(
        {"typ": "dpop+jwt", "alg": "ES256", "jwk": values["public_jwk"]},
        payload,
        ECKey.import_key(values["private_jwk"]),
        algorithms=["ES256"],
        default_type=None,
    )


@overload
def verify_strict_dpop(proof: str, input: VerifyStrictDpopInput, /) -> VerifiedDpop: ...


@overload
def verify_strict_dpop(
    proof: str,
    *,
    method: str,
    url: str,
    replay: Replay,
    access_token: str | None = None,
    expected_jkt: str | None = None,
    now: int | None = None,
) -> VerifiedDpop: ...


def verify_strict_dpop(
    proof: str,
    input: Mapping[str, Any] | None = None,
    **kwargs: Any,
) -> VerifiedDpop:
    values = dict(input or {})
    values.update(kwargs)
    try:
        header = decode_protected_header(proof)
        if (
            header.get("typ") != "dpop+jwt"
            or header.get("alg") != "ES256"
            or "crit" in header
            or not isinstance(header.get("jwk"), dict)
        ):
            raise ValueError("header")
        proof_jwk = dict(header["jwk"])
        assert_public_p256(proof_jwk)
    except Exception as error:
        raise WeldallAuthError("invalid_dpop_proof", "invalid DPoP header") from error
    try:
        jwt.decode(proof, ECKey.import_key(proof_jwk), algorithms=["ES256"])
        payload = decode_jwt(proof)
        _validate_registered_times(
            payload,
            now=int(time.time()),
            tolerance=0,
            require_exp=False,
            require_iat=False,
        )
    except Exception as error:
        raise WeldallAuthError("invalid_dpop_proof", "invalid DPoP signature") from error

    htm = payload.get("htm")
    htu = payload.get("htu")
    iat = payload.get("iat")
    jti = payload.get("jti")
    ath = payload.get("ath")
    now_value = values.get("now")
    now = int(time.time()) if now_value is None else now_value
    try:
        proof_url = parse_absolute(htu, "DPoP htu") if isinstance(htu, str) else None
    except TypeError as error:
        raise WeldallAuthError("invalid_dpop_proof", "invalid DPoP htu") from error
    try:
        invalid = (
            not isinstance(htm, str)
            or htm != str(values["method"]).upper()
            or not isinstance(htu, str)
            or proof_url is None
            or bool(proof_url.query)
            or bool(proof_url.fragment)
            or normalize_htu(htu) != normalize_htu(values["url"])
            or type(iat) is not int
            or iat < now - DPOP_MAX_AGE_SECONDS
            or iat > now + DPOP_FUTURE_SKEW_SECONDS
            or not isinstance(jti, str)
            or len(jti) < 1
            or len(jti) > 128
        )
    except Exception as error:
        if isinstance(error, WeldallAuthError):
            raise
        raise WeldallAuthError("invalid_dpop_proof", "invalid DPoP claims") from error
    if invalid:
        raise WeldallAuthError("invalid_dpop_proof", "invalid DPoP claims")
    assert type(iat) is int

    jkt = calculate_jwk_thumbprint(proof_jwk)
    expected_jkt = values.get("expected_jkt")
    if expected_jkt is not None and not safe_equal(jkt, expected_jkt):
        raise WeldallAuthError("invalid_dpop_proof", "DPoP key mismatch")
    access_token = values.get("access_token")
    if access_token:
        if not isinstance(ath, str) or not safe_equal(ath, base64url_sha256(access_token)):
            raise WeldallAuthError("invalid_dpop_proof", "access token hash mismatch")
    elif "ath" in payload:
        raise WeldallAuthError("invalid_dpop_proof", "ath is not allowed at this endpoint")
    consume_replay(
        values["replay"],
        "dpop",
        f"{jkt}:{jti}",
        datetime.fromtimestamp(iat + DPOP_MAX_AGE_SECONDS + 1, tz=UTC),
        {"code": "invalid_dpop_proof", "message": "proof was already used"},
    )
    return VerifiedDpop(payload=payload, public_jwk=proof_jwk, jkt=jkt)
