from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from joserfc import jwt
from joserfc.jwk import ECKey

from weldall import (
    WeldallAuthError,
    WeldallDiscovery,
    generate_es256_key_pair,
    sign_es256,
    sign_with_provider,
    validated_jwks,
)

ISSUER = "https://weldall.example"


def client_for(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_discovery_failure_is_shared_by_concurrent_callers():
    calls: list[str] = []
    callers = threading.Barrier(5)
    entered = threading.Event()
    release = threading.Event()

    def handler(request):
        calls.append(str(request.url))
        if request.url.path.endswith("oauth-authorization-server"):
            return httpx.Response(
                200,
                json={"issuer": ISSUER, "jwks_uri": f"{ISSUER}/jwks"},
            )
        entered.set()
        assert release.wait(2)
        raise httpx.ConnectError("offline", request=request)

    discovery = WeldallDiscovery(ISSUER, ISSUER, http_client=client_for(handler))

    def ready():
        callers.wait()
        with pytest.raises(WeldallAuthError) as caught:
            discovery.ready()
        assert caught.value.code == "temporarily_unavailable"

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(ready) for _ in range(4)]
        callers.wait()
        assert entered.wait(2)
        time.sleep(0.05)
        assert calls.count(f"{ISSUER}/jwks") == 1
        release.set()
        for future in futures:
            future.result()
    assert calls.count(f"{ISSUER}/.well-known/oauth-authorization-server") == 1
    assert calls.count(f"{ISSUER}/jwks") == 1


def test_discovery_ready_is_single_flight():
    key = generate_es256_key_pair()
    calls = []
    barrier = threading.Barrier(5)
    jwks_entered = threading.Event()
    jwks_release = threading.Event()

    def handler(request):
        calls.append(str(request.url))
        if request.url.path.endswith("oauth-authorization-server"):
            return httpx.Response(
                200,
                json={"issuer": ISSUER, "jwks_uri": f"{ISSUER}/jwks"},
            )
        jwks_entered.set()
        assert jwks_release.wait(2)
        return httpx.Response(
            200,
            json={"keys": [{**key["public_jwk"], "kid": "key", "alg": "ES256"}]},
        )

    discovery = WeldallDiscovery(ISSUER, ISSUER, http_client=client_for(handler))

    def ready():
        barrier.wait()
        discovery.ready()

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(ready) for _ in range(4)]
        barrier.wait()
        assert jwks_entered.wait(2)
        time.sleep(0.05)
        assert calls.count(f"{ISSUER}/jwks") == 1
        jwks_release.set()
        for future in futures:
            future.result()
    assert calls.count(f"{ISSUER}/.well-known/oauth-authorization-server") == 1
    assert calls.count(f"{ISSUER}/jwks") == 1


@pytest.mark.parametrize(
    "metadata",
    [
        {"issuer": "https://evil.example", "jwks_uri": f"{ISSUER}/jwks"},
        {"issuer": ISSUER, "jwks_uri": "https://evil.example/jwks"},
        {"issuer": ISSUER, "jwks_uri": f"{ISSUER}/jwks?redirect=evil"},
        {"issuer": ISSUER, "jwks_uri": "https://user@weldall.example/jwks"},
    ],
)
def test_discovery_rejects_unsafe_metadata(metadata):
    discovery = WeldallDiscovery(
        ISSUER,
        ISSUER,
        http_client=client_for(lambda request: httpx.Response(200, json=metadata)),
    )
    with pytest.raises(WeldallAuthError) as caught:
        discovery.ready()
    assert (caught.value.code, caught.value.status) == ("temporarily_unavailable", 503)


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, text="{}", headers={"content-type": "text/plain"}),
        httpx.Response(200, content=b"x" * 256_001, headers={"content-type": "application/json"}),
        httpx.Response(200, json={"keys": []}),
        httpx.Response(200, json={"keys": [{"kid": "x", "kty": "RSA"}]}),
    ],
)
def test_discovery_maps_jwks_failures(response):
    def handler(request):
        if request.url.path.endswith("oauth-authorization-server"):
            return httpx.Response(200, json={"issuer": ISSUER, "jwks_uri": f"{ISSUER}/jwks"})
        return response

    discovery = WeldallDiscovery(ISSUER, ISSUER, http_client=client_for(handler))
    with pytest.raises(WeldallAuthError) as caught:
        discovery.ready()
    assert (caught.value.code, caught.value.status) == ("temporarily_unavailable", 503)


def test_unknown_kid_refresh_is_throttled():
    key = generate_es256_key_pair()
    jwks_calls = 0

    def handler(request):
        nonlocal jwks_calls
        if request.url.path.endswith("oauth-authorization-server"):
            return httpx.Response(200, json={"issuer": ISSUER, "jwks_uri": f"{ISSUER}/jwks"})
        jwks_calls += 1
        return httpx.Response(
            200,
            json={"keys": [{**key["public_jwk"], "kid": "known", "alg": "ES256"}]},
        )

    discovery = WeldallDiscovery(ISSUER, ISSUER, http_client=client_for(handler))
    token = sign_es256(
        {"iss": ISSUER, "aud": ISSUER, "iat": 1, "exp": 2},
        kid="unknown",
        private_jwk=key["private_jwk"],
        typ="oauth-id-jag+jwt",
    )
    for _ in range(2):
        with pytest.raises(WeldallAuthError, match="unknown"):
            discovery.get_key(token)
    assert jwks_calls == 2


def test_signing_provider_published_key_and_output_guards():
    key = generate_es256_key_pair()
    provider = {
        "current": lambda: {
            "kid": "kms",
            "public_jwk": key["public_jwk"],
            "sign": lambda payload, header: sign_es256(
                payload,
                kid=header["kid"],
                private_jwk=key["private_jwk"],
                typ=header["typ"],
            ),
        },
        "jwks": lambda: [{**key["public_jwk"], "kid": "kms"}],
    }
    assert validated_jwks(provider)[0]["alg"] == "ES256"
    assert sign_with_provider(provider, {"value": 1}, "at+jwt")

    other = generate_es256_key_pair()
    unpublished = {**provider, "jwks": lambda: [{**other["public_jwk"], "kid": "kms"}]}
    with pytest.raises(WeldallAuthError, match="not present"):
        sign_with_provider(unpublished, {"value": 1}, "at+jwt")

    malformed = {
        **provider,
        "current": lambda: {
            "kid": "kms",
            "public_jwk": key["public_jwk"],
            "sign": lambda payload, header: "not-a-jwt",
        },
    }
    with pytest.raises(WeldallAuthError, match="invalid signature"):
        sign_with_provider(malformed, {"value": 1}, "at+jwt")

    def mutate_boolean(payload, header):
        payload["email_verified"] = 1
        return sign_es256(
            payload,
            kid=header["kid"],
            private_jwk=key["private_jwk"],
            typ=header["typ"],
        )

    type_confused = {
        **provider,
        "current": lambda: {
            "kid": "kms",
            "public_jwk": key["public_jwk"],
            "sign": mutate_boolean,
        },
    }
    with pytest.raises(WeldallAuthError, match="invalid signature"):
        sign_with_provider(type_confused, {"email_verified": True}, "at+jwt")

    def sign_with_crit(payload, header):
        return jwt.encode(
            {**header, "crit": []},
            payload,
            ECKey.import_key(key["private_jwk"]),
            algorithms=["ES256"],
            default_type=None,
        )

    critical = {
        **provider,
        "current": lambda: {
            "kid": "kms",
            "public_jwk": key["public_jwk"],
            "sign": sign_with_crit,
        },
    }
    with pytest.raises(WeldallAuthError, match="invalid signature"):
        sign_with_provider(critical, {"value": 1}, "at+jwt")

    now = int(time.time())
    for invalid_times in ({"exp": now - 1}, {"nbf": now + 60}, {"iat": "bad"}):
        with pytest.raises(WeldallAuthError, match="invalid signature"):
            sign_with_provider(provider, invalid_times, "at+jwt")
