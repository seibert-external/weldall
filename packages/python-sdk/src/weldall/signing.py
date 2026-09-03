"""Direct and provider-backed signing with KMS safety checks."""

from __future__ import annotations

import copy
import time
from collections.abc import Mapping
from typing import Any, cast

from joserfc import jwt
from joserfc.jwk import ECKey

from .crypto import (
    assert_public_p256,
    calculate_jwk_thumbprint,
    safe_equal,
    validate_es256_key_pair,
)
from .errors import WeldallAuthError
from .jwt import (
    _validate_registered_times,
    decode_jwt,
    decode_protected_header,
    sign_es256,
)
from .types import JWK, JWTPayload, ProviderSigningKey, Signing, SigningKeyProvider


def _get(value: object, name: str, default: Any = None) -> Any:
    return value.get(name, default) if isinstance(value, Mapping) else getattr(value, name, default)


def _is_direct(signing: object) -> bool:
    return isinstance(signing, Mapping) and "private_jwk" in signing


def _deep_strict_equal(left: object, right: object) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is bool and type(right) is bool and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(
            _deep_strict_equal(left[key], right[key]) for key in left
        )
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(
            _deep_strict_equal(left_item, right_item)
            for left_item, right_item in zip(left, right, strict=True)
        )
    return type(left) is type(right) and left == right


def assert_signing_config(signing: Signing) -> None:
    if not signing:
        raise TypeError("signing_key is required")
    if _is_direct(signing):
        kid = _get(signing, "kid")
        private = _get(signing, "private_jwk")
        public = _get(signing, "public_jwk")
        if (
            not isinstance(kid, str)
            or not kid
            or not isinstance(private, dict)
            or not isinstance(public, dict)
        ):
            raise TypeError("invalid direct signing key")
        try:
            if (
                private.get("kty") != "EC"
                or private.get("crv") != "P-256"
                or not private.get("d")
                or public.get("kty") != "EC"
                or public.get("crv") != "P-256"
                or "d" in public
            ):
                raise ValueError("shape")
            validate_es256_key_pair(private, public)
        except Exception as error:
            raise TypeError("invalid direct ES256 signing key") from error
        return
    if not callable(_get(signing, "current")) or not callable(_get(signing, "jwks")):
        raise TypeError("invalid signing key provider")


class _DirectProvider:
    def __init__(self, signing: Mapping[str, Any]) -> None:
        self._kid = signing["kid"]
        self._private, self._public = validate_es256_key_pair(
            signing["private_jwk"], signing["public_jwk"]
        )

    def current(self) -> ProviderSigningKey:
        private = self._private

        def sign(payload: JWTPayload, header: dict[str, str]) -> str:
            return sign_es256(
                payload,
                kid=header["kid"],
                private_jwk=private,
                typ=header["typ"],
            )

        return {"kid": self._kid, "public_jwk": dict(self._public), "sign": sign}

    def jwks(self) -> list[JWK]:
        return [{**self._public, "kid": self._kid, "alg": "ES256", "use": "sig"}]


def create_signing_provider(signing: Signing) -> SigningKeyProvider:
    if _is_direct(signing):
        return _DirectProvider(cast(Mapping[str, Any], signing))
    return cast(SigningKeyProvider, signing)


def validated_jwks(provider: SigningKeyProvider) -> list[JWK]:
    try:
        keys = _get(provider, "jwks")()
    except Exception as error:
        raise WeldallAuthError("server_error", "signing provider unavailable", 500) from error
    if not isinstance(keys, (list, tuple)) or not 1 <= len(keys) <= 20:
        raise WeldallAuthError("server_error", "signing provider returned an invalid JWKS", 500)
    result: list[JWK] = []
    kids: set[str] = set()
    for candidate in keys:
        kid = candidate.get("kid") if isinstance(candidate, dict) else None
        if not isinstance(kid, str) or not kid or kid in kids:
            raise WeldallAuthError("server_error", "signing provider returned an invalid JWKS", 500)
        try:
            assert_public_p256(candidate)
        except Exception as error:
            raise WeldallAuthError(
                "server_error", "signing provider returned an invalid JWKS", 500
            ) from error
        kids.add(kid)
        result.append({**candidate, "kid": kid, "alg": "ES256", "use": "sig"})
    return result


def sign_with_provider(provider: SigningKeyProvider, payload: JWTPayload, typ: str) -> str:
    try:
        key = _get(provider, "current")()
    except Exception as error:
        raise WeldallAuthError("server_error", "signing provider unavailable", 500) from error
    kid = _get(key, "kid")
    public_jwk = _get(key, "public_jwk")
    signer = _get(key, "sign")
    if not isinstance(kid, str) or not kid or not callable(signer):
        raise WeldallAuthError("server_error", "signing provider returned an invalid key", 500)
    verification_jwk = copy.deepcopy(public_jwk)
    try:
        assert_public_p256(verification_jwk)
    except Exception as error:
        raise WeldallAuthError(
            "server_error", "signing provider returned an invalid key", 500
        ) from error
    published = validated_jwks(provider)
    published_key = next((candidate for candidate in published if candidate["kid"] == kid), None)
    if published_key is None or not safe_equal(
        calculate_jwk_thumbprint(published_key), calculate_jwk_thumbprint(verification_jwk)
    ):
        raise WeldallAuthError(
            "server_error", "active signing key is not present in provider JWKS", 500
        )
    header = {"alg": "ES256", "kid": kid, "typ": typ}
    expected = copy.deepcopy(payload)
    try:
        token = signer(copy.deepcopy(expected), dict(header))
        if not isinstance(token, str):
            raise TypeError("signer returned non-string")
    except Exception as error:
        raise WeldallAuthError("server_error", "token signing failed", 500) from error
    try:
        verified = jwt.decode(token, ECKey.import_key(verification_jwk), algorithms=["ES256"])
        actual_header = decode_protected_header(token)
        actual_payload = decode_jwt(token)
        _validate_registered_times(
            actual_payload,
            now=time.time_ns() // 1_000_000_000,
            tolerance=0,
            require_exp=False,
            require_iat=False,
        )
        if (
            actual_header.get("kid") != kid
            or actual_header.get("alg") != "ES256"
            or actual_header.get("typ") != typ
            or "crit" in actual_header
            or not _deep_strict_equal(actual_payload, expected)
            or not _deep_strict_equal(dict(verified.claims), expected)
        ):
            raise ValueError("provider changed token")
    except Exception as error:
        raise WeldallAuthError(
            "server_error", "signing provider returned an invalid signature", 500
        ) from error
    return token
