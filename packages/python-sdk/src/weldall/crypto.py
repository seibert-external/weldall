"""ES256 and RFC 7638 helpers."""

from __future__ import annotations

import base64
import hashlib
import hmac

from joserfc.jwk import ECKey, import_key

from .types import JWK, DpopKeyPair

_PUBLIC_KEYS = {"kty", "crv", "x", "y", "use", "key_ops", "kid", "alg"}


def base64url_sha256(value: bytes | str) -> str:
    raw = value.encode("ascii") if isinstance(value, str) else value
    return base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).rstrip(b"=").decode("ascii")


def safe_equal(a: str, b: str) -> bool:
    try:
        aa = a.encode()
        bb = b.encode()
    except (AttributeError, UnicodeEncodeError):
        return False
    return len(aa) == len(bb) and hmac.compare_digest(aa, bb)


def is_sha256_jwk_thumbprint(value: object) -> bool:
    if not isinstance(value, str) or len(value) != 43:
        return False
    return all(c.isascii() and (c.isalnum() or c in "_-") for c in value)


def calculate_jwk_thumbprint(jwk: JWK) -> str:
    """Calculate an RFC 7638 SHA-256 thumbprint for a supported JWK."""

    return import_key(jwk).thumbprint()


def public_jwk(jwk: JWK) -> JWK:
    if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256" or not jwk.get("x") or not jwk.get("y"):
        raise ValueError("invalid P-256 JWK")
    ECKey.import_key(jwk)
    return {"kty": "EC", "crv": "P-256", "x": jwk["x"], "y": jwk["y"]}


def generate_es256_key_pair() -> DpopKeyPair:
    key = ECKey.generate_key("P-256", private=True)
    private = dict(key.as_dict(private=True))
    public = dict(key.as_dict(private=False))
    return {"private_jwk": private, "public_jwk": public, "jkt": key.thumbprint()}


def assert_public_p256(jwk: JWK) -> None:
    if (
        not isinstance(jwk, dict)
        or jwk.get("kty") != "EC"
        or jwk.get("crv") != "P-256"
        or not isinstance(jwk.get("x"), str)
        or not jwk.get("x")
        or not isinstance(jwk.get("y"), str)
        or not jwk.get("y")
        or "d" in jwk
        or ("alg" in jwk and jwk["alg"] != "ES256")
        or ("use" in jwk and jwk["use"] != "sig")
        or ("key_ops" in jwk and jwk["key_ops"] != ["verify"])
        or any(key not in _PUBLIC_KEYS for key in jwk)
    ):
        raise ValueError("invalid public P-256 JWK")
    ECKey.import_key({"kty": "EC", "crv": "P-256", "x": jwk["x"], "y": jwk["y"]})


def validate_es256_key_pair(private_jwk: JWK, configured_public_jwk: JWK) -> tuple[JWK, JWK]:
    if (
        not isinstance(private_jwk, dict)
        or private_jwk.get("kty") != "EC"
        or private_jwk.get("crv") != "P-256"
        or not private_jwk.get("x")
        or not private_jwk.get("y")
        or not private_jwk.get("d")
    ):
        raise ValueError("invalid private P-256 JWK")
    ECKey.import_key(private_jwk)
    assert_public_p256(configured_public_jwk)
    derived = public_jwk(private_jwk)
    if not safe_equal(
        calculate_jwk_thumbprint(derived), calculate_jwk_thumbprint(configured_public_jwk)
    ):
        raise ValueError("ES256 public/private key mismatch")
    return dict(private_jwk), derived
