from __future__ import annotations

import time
import uuid
from urllib.parse import parse_qs

import httpx
import pytest
from conftest import HOST, ORIGIN, RESOURCE, make_sdk

from weldall import (
    MACHINE_TOKEN_TYP,
    Request,
    WeldallAuthError,
    create_dpop_proof,
    create_machine_client_assertion,
    decode_jwt,
    decode_protected_header,
    generate_es256_key_pair,
    in_memory,
    request_machine_token,
    sign_es256,
    verify_es256,
    verify_strict_dpop,
)


def machine_token(keys, patch=None, typ=MACHINE_TOKEN_TYP):
    now = int(time.time())
    claims = {
        "iss": HOST,
        "sub": "machine:expenses-a",
        "client_id": "expenses-a",
        "azp": "expenses-a",
        "aud": RESOURCE,
        "scope": "expenses:read",
        "identity_type": "machine",
        "token_type": "machine",
        "cnf": {"jkt": keys.machine["jkt"]},
        "iat": now,
        "exp": now + 300,
        "jti": f"token-{uuid.uuid4()}",
    }
    claims.update(patch or {})
    return sign_es256(
        claims,
        kid="w1",
        private_jwk=keys.issuer["private_jwk"],
        typ=typ,
    )


def machine_request(token, keys, key=None, method="GET", proof_url=None, with_ath=True):
    url = f"{RESOURCE}/expenses"
    proof = create_dpop_proof(
        **(key or keys.machine),
        method=method,
        url=proof_url or url,
        **({"access_token": token} if with_ath else {}),
    )
    return Request(
        method,
        url,
        {"authorization": f"DPoP {token}", "dpop": proof},
    )


def test_rfc7523_assertion_has_no_private_material(keys):
    assertion = create_machine_client_assertion(
        client_id="expenses-a",
        token_endpoint=f"{HOST}/api/auth/oauth2/token",
        kid="a1",
        private_jwk=keys.machine["private_jwk"],
        jti="assertion-1",
        now=1000,
    )
    assert decode_protected_header(assertion) == {"alg": "ES256", "kid": "a1", "typ": "JWT"}
    assert {
        "iss": "expenses-a",
        "sub": "expenses-a",
        "aud": f"{HOST}/api/auth/oauth2/token",
        "iat": 1000,
        "exp": 1060,
        "jti": "assertion-1",
    }.items() <= decode_jwt(assertion).items()
    assert keys.machine["private_jwk"]["d"] not in str(decode_jwt(assertion))
    current_assertion = create_machine_client_assertion(
        client_id="expenses-a",
        token_endpoint=f"{HOST}/api/auth/oauth2/token",
        kid="a1",
        private_jwk=keys.machine["private_jwk"],
        jti="assertion-current",
    )
    verified = verify_es256(
        current_assertion,
        issuer="expenses-a",
        audience=f"{HOST}/api/auth/oauth2/token",
        kid="a1",
        public_jwk=keys.machine["public_jwk"],
        max_token_age_s=60,
    )
    assert verified["jti"] == "assertion-current"


@pytest.mark.parametrize("field", ["client_id", "kid"])
@pytest.mark.parametrize("value", ["", "has space", "x" * 129])
def test_machine_client_and_kid_validation(keys, field, value):
    arguments = {
        "client_id": "expenses-a",
        "token_endpoint": f"{HOST}/token",
        "kid": "a1",
        "private_jwk": keys.machine["private_jwk"],
    }
    arguments[field] = value
    with pytest.raises(TypeError):
        create_machine_client_assertion(**arguments)


def test_request_machine_token_binds_dpop(keys):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["headers"] = request.headers
        seen["form"] = parse_qs(request.content.decode())
        form = seen["form"]
        assert form["grant_type"] == ["client_credentials"]
        assert form["client_id"] == ["expenses-a"]
        assert form["client_assertion_type"] == [
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
        ]
        assert form["resource"] == [RESOURCE]
        assert form["scope"] == ["expenses:read"]
        assertion = verify_es256(
            form["client_assertion"][0],
            issuer="expenses-a",
            audience=str(request.url),
            kid="a1",
            public_jwk=keys.machine["public_jwk"],
            max_token_age_s=60,
        )
        assert assertion["iss"] == assertion["sub"] == "expenses-a"
        proof = verify_strict_dpop(
            request.headers["dpop"],
            method="POST",
            url=str(request.url),
            replay="disabled",
            expected_jkt=keys.machine["jkt"],
        )
        assert proof.jkt == keys.machine["jkt"]
        return httpx.Response(
            200,
            json={
                "access_token": "opaque-for-helper-test",
                "token_type": "DPoP",
                "expires_in": 300,
                "scope": "expenses:read",
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = request_machine_token(
        issuer=HOST,
        client_id="expenses-a",
        resource="https://expenses.example:443/api",
        scopes=["expenses:read"],
        kid="a1",
        key=keys.machine,
        http_client=client,
    )
    assert result["token_type"] == "DPoP"
    assert seen["form"]["grant_type"] == ["client_credentials"]
    assert seen["form"]["resource"] == [RESOURCE]
    assert seen["headers"]["dpop"]


def test_machine_request_errors(keys):
    base = {
        "issuer": HOST,
        "client_id": "expenses-a",
        "resource": RESOURCE,
        "scopes": ["expenses:read"],
        "kid": "a1",
        "key": keys.machine,
    }
    error_client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(400, json={"error": "invalid_scope"})
        )
    )
    with pytest.raises(WeldallAuthError) as caught:
        request_machine_token(**base, http_client=error_client)
    assert (caught.value.code, caught.value.status) == ("invalid_scope", 400)
    malformed = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"access_token": "x", "token_type": "Bearer"})
        )
    )
    with pytest.raises(WeldallAuthError) as caught:
        request_machine_token(**base, http_client=malformed)
    assert caught.value.status == 500
    with pytest.raises(TypeError, match="resource must be an origin"):
        request_machine_token(**{**base, "resource": f"{RESOURCE}?tenant=one"})


def test_machine_principal_replay_scope_and_disabled(keys, discovery):
    sdk = make_sdk(keys, discovery)
    token = machine_token(keys)
    first = machine_request(token, keys)
    auth = sdk.verify(first, {"scopes": ["expenses:read"]})
    assert auth.identity_type == "machine"
    assert auth.identity.client_id == "expenses-a"
    replay = sdk.verify_no_throw(first)
    assert not replay.ok
    assert replay.error.reason == "replay_detected"
    with pytest.raises(WeldallAuthError) as caught:
        sdk.verify(machine_request(token, keys), {"scopes": ["expenses:create"]})
    assert caught.value.status == 403

    disabled = make_sdk(keys, discovery, replay_store="disabled")
    repeated = machine_request(machine_token(keys), keys)
    assert disabled.verify(repeated).identity_type == "machine"
    assert disabled.verify(repeated).identity_type == "machine"


def test_replay_capacity_fails_closed(keys, discovery):
    sdk = make_sdk(keys, discovery, replay_store=in_memory(max_entries=1, suppress_warning=True))
    assert sdk.verify(machine_request(machine_token(keys), keys)).identity_type == "machine"
    result = sdk.verify_no_throw(machine_request(machine_token(keys), keys))
    assert not result.ok
    assert (result.error.code, result.error.status) == ("temporarily_unavailable", 503)


@pytest.mark.parametrize("typ", ["unknown+jwt", "oauth-id-jag+jwt", "at+jwt"])
def test_exact_typ_dispatch(keys, discovery, typ):
    with pytest.raises(WeldallAuthError) as caught:
        make_sdk(keys, discovery).verify(machine_request(machine_token(keys, typ=typ), keys))
    assert caught.value.code == "invalid_token"


@pytest.mark.parametrize(
    "patch",
    [
        {"identity_type": "user", "email": "a@example.com"},
        {"email": "a@example.com", "email_verified": True},
        {"sub": "user-1"},
        {"azp": "other"},
    ],
)
def test_machine_claim_confusion(keys, discovery, patch):
    with pytest.raises(WeldallAuthError) as caught:
        make_sdk(keys, discovery).verify(machine_request(machine_token(keys, patch), keys))
    assert caught.value.code == "invalid_token"


def test_user_profile_cannot_impersonate_machine(keys, discovery):
    now = int(time.time())
    token = sign_es256(
        {
            "iss": ORIGIN,
            "sub": "machine:expenses-a",
            "email": "a@example.com",
            "email_verified": True,
            "client_id": "weldall-cli-at-expenses",
            "aud": RESOURCE,
            "scope": "expenses:read",
            "identity_type": "machine",
            "token_type": "machine",
            "cnf": {"jkt": keys.machine["jkt"]},
            "iat": now,
            "exp": now + 600,
            "jti": str(uuid.uuid4()),
        },
        kid="local",
        private_jwk=keys.local["private_jwk"],
        typ="at+jwt",
    )
    with pytest.raises(WeldallAuthError):
        make_sdk(keys, discovery).verify(machine_request(token, keys))


def test_wrong_machine_proof_method_url_ath_and_key(keys, discovery):
    token = machine_token(keys)
    sdk = make_sdk(keys, discovery)
    wrong_method = machine_request(token, keys, method="POST")
    wrong_method.method = "GET"
    requests = [
        wrong_method,
        machine_request(token, keys, proof_url=f"{RESOURCE}/other"),
        machine_request(token, keys, with_ath=False),
        machine_request(token, keys, key=generate_es256_key_pair()),
    ]
    for request in requests:
        with pytest.raises(WeldallAuthError) as caught:
            sdk.verify(request)
        assert caught.value.code == "invalid_dpop_proof"


def test_wrong_machine_issuer_and_audience(keys, discovery):
    sdk = make_sdk(keys, discovery)
    for patch in [
        {"aud": "https://other.example/api"},
        {"iss": "https://other.example"},
    ]:
        with pytest.raises(WeldallAuthError) as caught:
            sdk.verify(machine_request(machine_token(keys, patch), keys))
        assert caught.value.code == "invalid_token"
