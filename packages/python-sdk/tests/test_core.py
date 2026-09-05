from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC
from urllib.parse import urlencode

import pytest
from conftest import (
    CLIENT_ID,
    HOST,
    ORIGIN,
    RESOURCE,
    DiscoveryState,
    exchange,
    make_assertion,
    make_sdk,
    protected_request,
)

from weldall import (
    JWT_DPOP_GRANT,
    Request,
    WeldallAuthError,
    consume_replay,
    create_dpop_proof,
    decode_jwt,
    generate_es256_key_pair,
    in_memory,
    init_weldall,
    issue_access_token,
    oauth_error_response,
    sign_es256,
    verify_access_token,
    verify_id_jag,
)


def test_invalid_configuration_is_synchronous(keys, discovery):
    base = {
        "resource": RESOURCE,
        "public_origin": ORIGIN,
        "client_id": CLIENT_ID,
        "supported_scopes": [],
        "signing_key": {
            "kid": "local",
            "private_jwk": keys.local["private_jwk"],
            "public_jwk": keys.local["public_jwk"],
        },
        "replay_store": "disabled",
        "_http_client": discovery.client(),
    }
    with pytest.raises(TypeError, match="HTTPS"):
        init_weldall("http://remote.example", base)
    with pytest.raises(TypeError, match="origin"):
        init_weldall(HOST, {**base, "public_origin": f"{ORIGIN}/path"})
    with pytest.raises(TypeError, match="signing key"):
        init_weldall(
            HOST,
            {
                **base,
                "signing_key": {
                    "kid": "bad",
                    "private_jwk": keys.local["private_jwk"],
                    "public_jwk": keys.issuer["public_jwk"],
                },
            },
        )
    with pytest.raises(TypeError, match="discoveryTimeoutMs"):
        init_weldall(HOST, {**base, "discovery_timeout_ms": 0})
    with pytest.raises(TypeError, match="replayStore"):
        init_weldall(HOST, {**base, "replay_store": None})
    with pytest.raises(TypeError, match="replay protection"):
        init_weldall(HOST, {**base, "skills": {"items": []}})
    init_weldall(HOST, base)


def test_in_memory_warns_once():
    import weldall.replay as replay

    replay._warned = False
    with pytest.warns(RuntimeWarning):
        in_memory()
    with warnings_not_emitted():
        in_memory()
        in_memory(suppress_warning=True)


class warnings_not_emitted:
    def __enter__(self):
        import warnings

        self.caught = warnings.catch_warnings(record=True)
        self.values = self.caught.__enter__()
        warnings.simplefilter("always")
        return self

    def __exit__(self, *args):
        result = self.caught.__exit__(*args)
        assert self.values == []
        return result


def test_ready_and_metadata(keys, discovery):
    sdk = make_sdk(keys, discovery)
    assert discovery.calls == []
    sdk.ready()
    assert discovery.calls == [
        f"{HOST}/.well-known/oauth-authorization-server",
        f"{HOST}/api/oauth/jwks",
    ]
    metadata = sdk.handlers.authorization_server_metadata().json_body()
    assert metadata == {
        "issuer": ORIGIN,
        "token_endpoint": f"{ORIGIN}/oauth/token",
        "jwks_uri": f"{ORIGIN}/.well-known/jwks.json",
        "grant_types_supported": [JWT_DPOP_GRANT],
        "response_types_supported": [],
        "token_endpoint_auth_methods_supported": ["none"],
        "dpop_signing_alg_values_supported": ["ES256"],
        "urn:weldall:jwt-dpop-draft": "draft-parecki-oauth-jwt-dpop-grant-01",
    }
    protected = sdk.handlers.protected_resource_metadata().json_body()
    assert protected == {
        "resource": RESOURCE,
        "authorization_servers": [ORIGIN],
        "scopes_supported": ["read", "write", "admin", "expenses:read", "expenses:create"],
        "bearer_methods_supported": ["header"],
        "dpop_signing_alg_values_supported": ["ES256"],
    }
    assert [key["kid"] for key in sdk.handlers.jwks().json_body()["keys"]] == ["local"]


def test_discovery_proxy_rewrites_only_transport_origin(keys, discovery):
    proxy = "https://weldall-proxy.example"
    sdk = make_sdk(keys, discovery, discovery_proxy_origin=proxy)
    sdk.ready()
    assert discovery.calls == [
        f"{proxy}/.well-known/oauth-authorization-server",
        f"{proxy}/api/oauth/jwks",
    ]
    assert exchange(sdk, keys)[0].status == 200


def test_skill_catalog_is_protected_and_replay_safe(keys, discovery):
    sdk = make_sdk(
        keys,
        discovery,
        supported_scopes=["expenses:read"],
        skills={
            "items": [
                {
                    "id": "review",
                    "title": "Review expenses",
                    "requiredScopes": ["expenses:read"],
                    "visibility": "DEFAULT",
                    "content": "# Review expenses",
                    "meta": {
                        "tags": ["finance", "review"],
                        "owner": "user-123",
                        "appearance": {"icon": "file-text", "gradientFrom": "invalid-but-safe"},
                    },
                    "lastUpdatedAt": "not restricted to a timestamp",
                }
            ]
        },
    )
    assert sdk.handlers.protected_resource_metadata().json_body()["weldall_skills_endpoint"] == (
        f"{ORIGIN}/.well-known/weldall-skills"
    )
    import time

    now = int(time.time())
    assertion = sign_es256(
        {
            "iss": HOST,
            "sub": HOST,
            "aud": f"{ORIGIN}/.well-known/weldall-skills",
            "resource": RESOURCE,
            "purpose": "skills:read",
            "iat": now,
            "exp": now + 60,
            "jti": "skills-test",
        },
        kid="w1",
        private_jwk=keys.issuer["private_jwk"],
        typ="weldall-skills+jwt",
    )

    def request():
        return Request(
            "GET",
            f"{ORIGIN}/.well-known/weldall-skills",
            {"authorization": f"Bearer {assertion}"},
        )

    response = sdk.handlers.skills(request())
    assert response.status == 200
    assert response.json_body()["skills"][0]["meta"]["tags"] == ["finance", "review"]
    assert sdk.handlers.skills(request()).status == 401
    assert (
        sdk.handlers.skills(Request("POST", f"{ORIGIN}/.well-known/weldall-skills")).status == 405
    )


def test_oauth_error_and_replay_marker():
    response = oauth_error_response(RuntimeError("database unavailable"))
    assert response.status == 500
    assert response.json_body() == {
        "error": "server_error",
        "error_description": "server error",
    }
    from datetime import datetime, timedelta

    with pytest.raises(WeldallAuthError) as caught:
        consume_replay(
            type("Never", (), {"consume": lambda self, key, expiry: False})(),
            "dpop",
            "duplicate",
            datetime.now(UTC) + timedelta(seconds=60),
            {"code": "invalid_dpop_proof", "message": "already seen"},
        )
    assert caught.value.reason == "replay_detected"


def test_exchange_and_local_verify_offline(keys, discovery):
    sdk = make_sdk(keys, discovery)
    response, body = exchange(sdk, keys)
    assert response.status == 200
    claims = decode_jwt(body["access_token"])
    expected = {
        "iss": ORIGIN,
        "aud": RESOURCE,
        "sub": "user-1",
        "email": "user@example.com",
        "email_verified": True,
        "scope": "read write",
    }
    assert expected.items() <= claims.items()
    sdk.discovery._client.close()
    auth = sdk.verify(
        protected_request(body["access_token"], keys),
        {"scopes": ["read"], "any_scopes": ["write", "admin"]},
    )
    assert auth.identity_type == "user"
    assert auth.identity.email == "user@example.com"
    assert auth.scopes == ("read", "write")


@pytest.mark.parametrize(
    ("claim", "value"),
    [("iss", "https://wrong.example"), ("aud", "https://wrong.example/api")],
)
def test_wrong_local_issuer_or_audience(keys, discovery, claim, value):
    values = {
        "issuer": ORIGIN,
        "subject": "user-1",
        "email": "user@example.com",
        "resource": RESOURCE,
        "client_id": CLIENT_ID,
        "scopes": ["read"],
        "jkt": keys.device["jkt"],
        "kid": "local",
        "private_jwk": keys.local["private_jwk"],
    }
    if claim == "iss":
        values["issuer"] = value
    else:
        values["resource"] = value
    token = issue_access_token(**values)
    sdk = make_sdk(keys, discovery)
    with pytest.raises(WeldallAuthError) as caught:
        sdk.verify(protected_request(token, keys))
    assert (caught.value.code, caught.value.status) == ("invalid_token", 401)
    with pytest.raises(WeldallAuthError):
        verify_access_token(
            token,
            issuer=ORIGIN,
            resource=RESOURCE,
            client_id=CLIENT_ID,
            kid="local",
            public_jwk=keys.local["public_jwk"],
        )


@pytest.mark.parametrize(
    "patch",
    [{"email": None}, {"email": "not-an-email"}, {"email_verified": False}],
)
def test_access_token_email_confusion(keys, discovery, patch):
    token = issue_access_token(
        issuer=ORIGIN,
        subject="user-1",
        email="user@example.com",
        resource=RESOURCE,
        client_id=CLIENT_ID,
        scopes=["read"],
        jkt=keys.device["jkt"],
        kid="local",
        private_jwk=keys.local["private_jwk"],
    )
    claims = decode_jwt(token)
    claims.update(patch)
    confused = sign_es256(
        claims,
        kid="local",
        private_jwk=keys.local["private_jwk"],
        typ="at+jwt",
    )
    with pytest.raises(WeldallAuthError, match="access token"):
        make_sdk(keys, discovery).verify(protected_request(confused, keys))


def test_401_403_and_proof_replay(keys, discovery):
    sdk = make_sdk(keys, discovery)
    _, body = exchange(sdk, keys)
    request = protected_request(body["access_token"], keys)
    with pytest.raises(WeldallAuthError) as caught:
        sdk.verify(request, {"scopes": ["admin"]})
    assert caught.value.status == 403
    malformed = sdk.verify_no_throw(
        Request(
            "GET",
            f"{ORIGIN}/api/expenses",
            {"authorization": f"DPoP {body['access_token']}", "dpop": "bad"},
        )
    )
    assert not malformed.ok
    assert malformed.response.status == 401
    first = protected_request(body["access_token"], keys)
    sdk.verify(first)
    replay = sdk.verify_no_throw(first)
    assert not replay.ok
    assert replay.error.reason == "replay_detected"
    assert "invalid_dpop_proof" in replay.response.headers["www-authenticate"]


def test_network_path_cannot_escape_origin(keys, discovery):
    sdk = make_sdk(keys, discovery)
    _, body = exchange(sdk, keys)
    token = body["access_token"]
    proof = create_dpop_proof(
        **keys.device,
        method="GET",
        url="https://evil.example/path",
        access_token=token,
    )
    with pytest.raises(WeldallAuthError) as caught:
        sdk.verify(
            Request(
                "GET",
                f"{ORIGIN}//evil.example/path",
                {"authorization": f"DPoP {token}", "dpop": proof},
            )
        )
    assert caught.value.code == "invalid_dpop_proof"


@pytest.mark.parametrize(
    "override",
    [
        {"audience": "https://wrong.example"},
        {"client_id": "wrong"},
        {"resource": "https://wrong.example/api"},
        {"scopes": ["unknown"]},
    ],
)
def test_id_jag_pins_claims(keys, discovery, override):
    sdk = make_sdk(keys, discovery)
    response, _ = exchange(sdk, keys, make_assertion(keys, **override))
    assert response.status == 400


@pytest.mark.parametrize(
    "patch",
    [{"email": None}, {"email": "not-an-email"}, {"email_verified": False}],
)
def test_id_jag_rejects_email_confusion(keys, discovery, patch):
    claims = decode_jwt(make_assertion(keys))
    claims.update(patch)
    assertion = sign_es256(
        claims,
        kid="w1",
        private_jwk=keys.issuer["private_jwk"],
        typ="oauth-id-jag+jwt",
    )
    with pytest.raises(WeldallAuthError) as caught:
        verify_id_jag(
            assertion,
            issuer=HOST,
            audience=ORIGIN,
            resource=RESOURCE,
            client_id=CLIENT_ID,
            kid="w1",
            public_jwk=keys.issuer["public_jwk"],
            allowed_scopes=["read", "write"],
        )
    assert caught.value.code == "invalid_grant"
    assert exchange(make_sdk(keys, discovery), keys, assertion)[0].status == 400


def test_id_jag_atomic_consumption_and_strict_forms(keys, discovery):
    sdk = make_sdk(keys, discovery)
    jag = make_assertion(keys)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(exchange, sdk, keys, jag) for _ in range(2)]
        statuses = sorted(future.result()[0].status for future in futures)
    assert statuses == [200, 400]
    assert sdk.handlers.token(Request("GET", f"{ORIGIN}/oauth/token")).status == 400
    bad = sdk.handlers.token(
        Request(
            "POST",
            f"{ORIGIN}/oauth/token",
            {"content-type": "application/x-www-form-urlencoded", "dpop": "x"},
            urlencode({"grant_type": JWT_DPOP_GRANT, "assertion": "x", "extra": "x"}),
        )
    )
    assert bad.json_body()["error"] == "invalid_request"


@pytest.mark.parametrize(
    ("headers", "body", "description"),
    [
        ({"content-type": "application/json", "dpop": "x"}, "{}", "form content type required"),
        (
            {"content-type": "application/x-www-form-urlencoded", "dpop": "x"},
            "grant_type=a&grant_type=b&assertion=x",
            "invalid or duplicate OAuth parameter",
        ),
        (
            {"content-type": "application/x-www-form-urlencoded", "dpop": "x,y"},
            urlencode({"grant_type": JWT_DPOP_GRANT, "assertion": "x"}),
            "exactly one DPoP proof is required",
        ),
        (
            {"content-type": "application/x-www-form-urlencoded", "dpop": "x"},
            "😀" * 32_001,
            "form is too large",
        ),
    ],
)
def test_token_endpoint_strict_forms(keys, discovery, headers, body, description):
    response = make_sdk(keys, discovery).handlers.token(
        Request("POST", f"{ORIGIN}/oauth/token", headers, body)
    )
    assert response.status == 400
    assert response.json_body()["error_description"] == description


def test_any_scope_rejection_lists_complete_policy(keys, discovery):
    sdk = make_sdk(keys, discovery)
    _, body = exchange(sdk, keys)
    result = sdk.verify_no_throw(
        protected_request(body["access_token"], keys),
        {"scopes": ["read"], "any_scopes": ["admin"]},
    )
    assert not result.ok
    assert result.error.required_scopes == ["read", "admin"]
    assert result.response.headers["www-authenticate"].endswith('scope="read admin"')


def test_unknown_and_reused_kid_rotation(keys, discovery):
    sdk = make_sdk(keys, discovery)
    sdk.ready()
    rotated = generate_es256_key_pair()
    discovery.key = rotated
    discovery.kid = "w2"
    response, _ = exchange(
        sdk,
        keys,
        make_assertion(keys, private_jwk=rotated["private_jwk"], kid="w2"),
    )
    assert response.status == 200
    assert discovery.calls.count(f"{HOST}/api/oauth/jwks") == 2

    state = DiscoveryState(keys.issuer)
    second = make_sdk(keys, state)
    second.ready()
    state.key = rotated
    response, _ = exchange(
        second,
        keys,
        make_assertion(keys, private_jwk=rotated["private_jwk"], kid="w1"),
    )
    assert response.status == 200
    assert state.calls.count(f"{HOST}/api/oauth/jwks") == 2


def test_same_kid_rotation_refresh_is_shared_concurrently(keys, discovery):
    sdk = make_sdk(keys, discovery)
    sdk.ready()
    rotated = generate_es256_key_pair()
    discovery.key = rotated
    discovery.jwks_entered = threading.Event()
    discovery.jwks_release = threading.Event()
    start = threading.Barrier(3)
    assertions = [
        make_assertion(keys, private_jwk=rotated["private_jwk"], kid="w1") for _ in range(2)
    ]

    def concurrent_exchange(assertion):
        start.wait()
        return exchange(sdk, keys, assertion)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(concurrent_exchange, assertion) for assertion in assertions]
        start.wait()
        assert discovery.jwks_entered.wait(2)
        time.sleep(0.05)
        assert discovery.calls.count(f"{HOST}/api/oauth/jwks") == 2
        discovery.jwks_release.set()
        statuses = [future.result()[0].status for future in futures]
    assert statuses == [200, 200]
    assert discovery.calls.count(f"{HOST}/api/oauth/jwks") == 2


def test_removed_key_is_not_trusted_after_ttl(keys, discovery):
    sdk = make_sdk(keys, discovery)
    sdk.ready()
    removed = keys.issuer
    discovery.key = generate_es256_key_pair()
    discovery.kid = "w2"
    sdk.discovery._jwks_expires_at = 0
    response, body = exchange(
        sdk,
        keys,
        make_assertion(keys, private_jwk=removed["private_jwk"], kid="w1"),
    )
    assert response.status == 400
    assert body["error"] == "invalid_grant"


def test_replay_store_failure_is_503(keys, discovery):
    class Broken:
        def consume(self, key, expiry):
            raise RuntimeError("redis unavailable")

    sdk = make_sdk(keys, discovery, replay_store=Broken())
    response, body = exchange(sdk, keys)
    assert (response.status, body["error"]) == (503, "temporarily_unavailable")


def test_kms_provider_and_mutation_safeguards(keys, discovery):
    provider = {
        "current": lambda: {
            "kid": "kms",
            "public_jwk": keys.local["public_jwk"],
            "sign": lambda payload, header: sign_es256(
                payload,
                kid=header["kid"],
                private_jwk=keys.local["private_jwk"],
                typ=header["typ"],
            ),
        },
        "jwks": lambda: [{**keys.local["public_jwk"], "kid": "kms"}],
    }
    sdk = make_sdk(keys, discovery, signing_key=provider)
    assert exchange(sdk, keys)[0].status == 200

    def mutate(payload, header):
        payload["scope"] = "admin"
        return sign_es256(
            payload,
            kid=header["kid"],
            private_jwk=keys.local["private_jwk"],
            typ=header["typ"],
        )

    provider["current"] = lambda: {
        "kid": "kms",
        "public_jwk": keys.local["public_jwk"],
        "sign": mutate,
    }
    broken = make_sdk(keys, DiscoveryState(keys.issuer), signing_key=provider)
    response, body = exchange(broken, keys)
    assert (response.status, body["error"]) == (500, "server_error")


def test_verify_id_jag_claim_helper(keys):
    jag = make_assertion(keys)
    claims = verify_id_jag(
        jag,
        issuer=HOST,
        audience=ORIGIN,
        resource=RESOURCE,
        client_id=CLIENT_ID,
        kid="w1",
        public_jwk=keys.issuer["public_jwk"],
        allowed_scopes=["read", "write"],
    )
    assert claims["sub"] == "user-1"
