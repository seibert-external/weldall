from __future__ import annotations

import math
import time

import pytest
from joserfc import jwt
from joserfc.jwk import ECKey

from weldall import (
    WeldallAuthError,
    assert_public_p256,
    base64url_sha256,
    calculate_jwk_thumbprint,
    create_dpop_proof,
    decode_jwt,
    generate_es256_key_pair,
    is_sha256_jwk_thumbprint,
    normalize_htu,
    public_jwk,
    safe_equal,
    sign_es256,
    validate_es256_key_pair,
    verify_es256,
    verify_strict_dpop,
)


def test_rfc7638_official_vector():
    thumbprint = calculate_jwk_thumbprint(
        {
            "kty": "RSA",
            "n": "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
            "e": "AQAB",
            "alg": "RS256",
            "kid": "2011-04-29",
        }
    )
    assert thumbprint == "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"
    assert is_sha256_jwk_thumbprint(thumbprint)


def test_keygen_roundtrip_and_public_validation():
    pair = generate_es256_key_pair()
    assert set(pair) == {"private_jwk", "public_jwk", "jkt"}
    assert public_jwk(pair["private_jwk"]) == pair["public_jwk"]
    private, public = validate_es256_key_pair(pair["private_jwk"], pair["public_jwk"])
    assert private["d"] and public == pair["public_jwk"]
    assert_public_p256({**public, "alg": "ES256", "use": "sig", "key_ops": ["verify"]})
    for bad in [
        {**public, "d": pair["private_jwk"]["d"]},
        {**public, "alg": "RS256"},
        {**public, "key_ops": ["sign"]},
        {**public, "unknown": "value"},
        {**public, "x": "bad"},
    ]:
        with pytest.raises((ValueError, TypeError)):
            assert_public_p256(bad)
    other = generate_es256_key_pair()
    with pytest.raises(ValueError, match="mismatch"):
        validate_es256_key_pair(pair["private_jwk"], other["public_jwk"])


def test_hash_and_safe_equal():
    assert base64url_sha256("abc") == "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"
    assert safe_equal("same", "same")
    assert not safe_equal("short", "longer")
    assert not is_sha256_jwk_thumbprint("x" * 42)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("https://EXAMPLE.com:443/path?q=1#x", "https://example.com/path"),
        ("http://localhost:80/path?q=1", "http://localhost/path"),
        ("http://127.0.0.1/a", "http://127.0.0.1/a"),
        ("http://127.1/a", "http://127.0.0.1/a"),
        ("http://[::1]:80/a", "http://[::1]/a"),
        ("https://[0:0:0:0:0:0:0:1]/a", "https://[::1]/a"),
        ("https://[::ffff:127.0.0.1]/a", "https://[::ffff:7f00:1]/a"),
        ("https:example.com/a", "https://example.com/a"),
        ("https:/example.com/a", "https://example.com/a"),
        ("https://a..com/a", "https://a..com/a"),
        ("https://example.com/a[b|c]", "https://example.com/a[b|c]"),
        ("https://example.com/a%5Bb%7Cc%5D", "https://example.com/a%5Bb%7Cc%5D"),
        ("https://example.com", "https://example.com/"),
    ],
)
def test_normalize_htu(value, expected):
    assert normalize_htu(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "http://example.com/path",
        "ftp://example.com/path",
        "https://user@example.com/path",
        "https://xn--.com/path",
    ],
)
def test_normalize_htu_rejects_unsafe(value):
    with pytest.raises(WeldallAuthError) as caught:
        normalize_htu(value)
    assert caught.value.code == "invalid_dpop_proof"


def _proof(pair, claims, header=None):
    return jwt.encode(
        header or {"typ": "dpop+jwt", "alg": "ES256", "jwk": pair["public_jwk"]},
        claims,
        ECKey.import_key(pair["private_jwk"]),
        algorithms=["ES256"],
        default_type=None,
    )


def test_dpop_roundtrip_ath_jkt_and_replay(keys):
    now = int(time.time())
    proof = create_dpop_proof(
        **keys.device,
        method="get",
        url="https://EXAMPLE.com:443/api?q=ignored",
        access_token="token",
        now=now,
        jti="proof-1",
    )
    from weldall import in_memory

    store = in_memory(suppress_warning=True)
    result = verify_strict_dpop(
        proof,
        method="GET",
        url="https://example.com/api?different=yes",
        replay=store,
        access_token="token",
        expected_jkt=keys.device["jkt"],
        now=now,
    )
    assert result.jkt == keys.device["jkt"]
    assert result.payload["ath"] == base64url_sha256("token")
    with pytest.raises(WeldallAuthError) as caught:
        verify_strict_dpop(
            proof,
            method="GET",
            url="https://example.com/api",
            replay=store,
            access_token="token",
            now=now,
        )
    assert caught.value.reason == "replay_detected"


def test_dpop_failed_checks_do_not_consume(keys):
    now = int(time.time())
    from weldall import in_memory

    store = in_memory(suppress_warning=True)
    proof = create_dpop_proof(
        **keys.device,
        method="GET",
        url="https://example.com/api",
        access_token="right",
        now=now,
    )
    with pytest.raises(WeldallAuthError, match="hash"):
        verify_strict_dpop(
            proof,
            method="GET",
            url="https://example.com/api",
            replay=store,
            access_token="wrong",
            now=now,
        )
    verify_strict_dpop(
        proof,
        method="GET",
        url="https://example.com/api",
        replay=store,
        access_token="right",
        now=now,
    )


@pytest.mark.parametrize("iat", [9_939, 10_006])
def test_dpop_rejects_outside_skew(keys, iat):
    proof = create_dpop_proof(
        **keys.device,
        method="GET",
        url="https://example.com/api",
        now=iat,
    )
    with pytest.raises(WeldallAuthError, match="claims"):
        verify_strict_dpop(
            proof,
            method="GET",
            url="https://example.com/api",
            replay="disabled",
            now=10_000,
        )


@pytest.mark.parametrize("iat", [9_940, 10_005])
def test_dpop_accepts_skew_boundaries(keys, iat):
    proof = create_dpop_proof(
        **keys.device,
        method="GET",
        url="https://example.com/api",
        now=iat,
    )
    verify_strict_dpop(
        proof,
        method="GET",
        url="https://example.com/api",
        replay="disabled",
        now=10_000,
    )


def test_dpop_header_signature_claim_and_binding_order(keys):
    now = 10_000
    claims = {"htm": "GET", "htu": "https://example.com/api", "iat": now, "jti": "x"}
    bad_headers = [
        {"typ": "JWT", "alg": "ES256", "jwk": keys.device["public_jwk"]},
        {"typ": "dpop+jwt", "alg": "ES256", "jwk": keys.device["public_jwk"], "crit": []},
        {
            "typ": "dpop+jwt",
            "alg": "ES256",
            "jwk": {**keys.device["public_jwk"], "d": keys.device["private_jwk"]["d"]},
        },
    ]
    for header in bad_headers:
        with pytest.raises(WeldallAuthError, match="header"):
            verify_strict_dpop(
                _proof(keys.device, claims, header),
                method="GET",
                url="https://example.com/api",
                replay="disabled",
                now=now,
            )
    with pytest.raises(WeldallAuthError, match="key mismatch"):
        verify_strict_dpop(
            _proof(keys.device, claims),
            method="GET",
            url="https://example.com/api",
            replay="disabled",
            expected_jkt=keys.issuer["jkt"],
            now=now,
        )
    proof_with_ath = _proof(keys.device, {**claims, "ath": base64url_sha256("token")})
    with pytest.raises(WeldallAuthError, match="not allowed"):
        verify_strict_dpop(
            proof_with_ath,
            method="GET",
            url="https://example.com/api",
            replay="disabled",
            now=now,
        )
    credential_proof = _proof(
        keys.device,
        {**claims, "htu": "https://user:pass@example.com/api"},
    )
    with pytest.raises(WeldallAuthError, match="credentials"):
        verify_strict_dpop(
            credential_proof,
            method="GET",
            url="https://example.com/api",
            replay="disabled",
            now=now,
        )


def test_dpop_rejects_tampering_registered_times_and_explicit_empty_jti(keys):
    now = int(time.time())
    claims = {"htm": "GET", "htu": "https://example.com/api", "iat": now, "jti": "x"}
    proof = _proof(keys.device, claims)
    parts = proof.split(".")
    replacement = "A" if parts[2][-1] != "A" else "B"
    tampered = ".".join([parts[0], parts[1], f"{parts[2][:-1]}{replacement}"])
    with pytest.raises(WeldallAuthError, match="signature"):
        verify_strict_dpop(
            tampered,
            method="GET",
            url="https://example.com/api",
            replay="disabled",
            now=now,
        )
    for registered in ({"nbf": now + 60}, {"exp": now - 1}):
        with pytest.raises(WeldallAuthError, match="signature"):
            verify_strict_dpop(
                _proof(keys.device, {**claims, **registered}),
                method="GET",
                url="https://example.com/api",
                replay="disabled",
                now=now,
            )
    empty_jti = create_dpop_proof(
        **keys.device,
        method="GET",
        url="https://example.com/api",
        now=now,
        jti="",
    )
    assert decode_jwt(empty_jti)["jti"] == ""
    with pytest.raises(WeldallAuthError, match="claims"):
        verify_strict_dpop(
            empty_jti,
            method="GET",
            url="https://example.com/api",
            replay="disabled",
            now=now,
        )


def test_jwt_rejects_nbf_and_non_finite_numeric_dates(keys):
    now = int(time.time())
    base = {"iss": "https://issuer.example", "aud": "https://api.example", "iat": now}
    future = sign_es256(
        {**base, "exp": now + 300, "nbf": now + 60},
        kid="key",
        private_jwk=keys.local["private_jwk"],
    )
    with pytest.raises(WeldallAuthError):
        verify_es256(
            future,
            issuer=base["iss"],
            audience=base["aud"],
            kid="key",
            public_jwk=keys.local["public_jwk"],
        )
    for claim, value in (("exp", math.inf), ("exp", math.nan), ("iat", math.nan)):
        malformed = sign_es256(
            {**base, "exp": now + 300, claim: value},
            kid="key",
            private_jwk=keys.local["private_jwk"],
        )
        with pytest.raises(WeldallAuthError):
            verify_es256(
                malformed,
                issuer=base["iss"],
                audience=base["aud"],
                kid="key",
                public_jwk=keys.local["public_jwk"],
            )


def test_whatwg_url_edge_normalization_matches_node():
    assert normalize_htu("https://x.example/a//../b") == "https://x.example/a/b"
    assert normalize_htu("https://x.example/a/%2e%2e/b") == "https://x.example/b"
    assert normalize_htu("https://%65xample.com/a b") == "https://example.com/a%20b"
    with pytest.raises(WeldallAuthError):
        normalize_htu("https://exa%2fmple.com/a")
