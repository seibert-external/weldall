from __future__ import annotations

import json
import time
import uuid
from urllib.parse import urlencode

import django
import pytest
from django.conf import settings

if not settings.configured:
    settings.configure(
        DEBUG=True,
        SECRET_KEY="test",
        ROOT_URLCONF=__name__,
        ALLOWED_HOSTS=["expenses.example", "testserver"],
        MIDDLEWARE=[],
    )
django.setup()

from conftest import CLIENT_ID, HOST, ORIGIN, RESOURCE, make_assertion
from django.http import JsonResponse
from django.test import RequestFactory
from fastapi import Depends, FastAPI
from fastapi import Request as FastAPIRequest
from fastapi.testclient import TestClient

from weldall import create_dpop_proof, issue_access_token, sign_es256
from weldall.adapters.django import init_weldall as init_django
from weldall.adapters.fastapi import init_weldall as init_fastapi


def user_artifacts(
    keys,
    url=f"{ORIGIN}/private",
    scopes=None,
    issuer=ORIGIN,
    resource=RESOURCE,
):
    token = issue_access_token(
        issuer=issuer,
        subject="adapter-user",
        email="adapter@example.com",
        resource=resource,
        client_id=CLIENT_ID,
        scopes=scopes or ["read"],
        jkt=keys.device["jkt"],
        kid="local",
        private_jwk=keys.local["private_jwk"],
    )
    proof = create_dpop_proof(**keys.device, method="GET", url=url, access_token=token)
    return token, proof


def options(keys, discovery):
    return {
        "resource": RESOURCE,
        "public_origin": ORIGIN,
        "client_id": CLIENT_ID,
        "supported_scopes": ["read", "other"],
        "signing_key": {
            "kid": "local",
            "private_jwk": keys.local["private_jwk"],
            "public_jwk": keys.local["public_jwk"],
        },
        "replay_store": __import__("weldall").in_memory(suppress_warning=True),
        "_http_client": discovery.client(),
    }


def test_fastapi_dependency_routes_errors_and_auth(keys, discovery):
    weldall = init_fastapi(HOST, options(keys, discovery))
    app = FastAPI()
    weldall.register_routes(app)

    @app.get("/private")
    def private(
        request: FastAPIRequest,
        auth=Depends(weldall.require_auth({"scopes": ["read"]})),
    ):
        assert weldall.get_auth(request) == auth
        return {"subject": auth.subject, "email": auth.email}

    client = TestClient(app, base_url=ORIGIN)
    metadata = client.get("/.well-known/oauth-protected-resource")
    assert metadata.status_code == 200
    assert metadata.json()["resource"] == RESOURCE
    missing = client.get("/private")
    assert missing.status_code == 401
    assert missing.headers["www-authenticate"] == 'DPoP error="invalid_token"'
    assert missing.json() == {
        "error": "invalid_token",
        "error_description": "DPoP authorization required",
    }
    for claims in (
        {"issuer": "https://wrong.example"},
        {"resource": "https://wrong.example/resource"},
    ):
        wrong_token, wrong_proof = user_artifacts(keys, **claims)
        wrong = client.get(
            "/private",
            headers={"authorization": f"DPoP {wrong_token}", "dpop": wrong_proof},
        )
        assert wrong.status_code == 401
    token, proof = user_artifacts(keys)
    success_headers = {"authorization": f"DPoP {token}", "dpop": proof}
    success = client.get("/private", headers=success_headers)
    assert success.json() == {"subject": "adapter-user", "email": "adapter@example.com"}
    assert client.get("/private", headers=success_headers).status_code == 401
    duplicate_token, duplicate_proof = user_artifacts(keys)
    duplicate = client.get(
        "/private",
        headers=[
            ("authorization", f"DPoP {duplicate_token}"),
            ("dpop", duplicate_proof),
            ("dpop", duplicate_proof),
        ],
    )
    assert duplicate.status_code == 401
    other_token, other_proof = user_artifacts(keys, scopes=["other"])
    denied = client.get(
        "/private",
        headers={"authorization": f"DPoP {other_token}", "dpop": other_proof},
    )
    assert denied.status_code == 403
    assert 'scope="read"' in denied.headers["www-authenticate"]
    assert client.get("/.well-known/jwks.json").status_code == 200
    assert client.get("/.well-known/oauth-protected-resource/api/expenses").status_code == 200
    assert client.get("/.well-known/weldall-skills").status_code == 404
    assert client.get("/oauth/token").status_code == 405
    assert client.post("/oauth/token", content=b"").status_code == 400
    assertion = make_assertion(keys, scopes=["read"])
    exchange_proof = create_dpop_proof(
        **keys.device,
        method="POST",
        url=f"{ORIGIN}/oauth/token",
    )
    exchange = client.post(
        "/oauth/token",
        content=urlencode(
            {
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-dpop",
                "assertion": assertion,
            }
        ),
        headers={
            "content-type": "application/x-www-form-urlencoded",
            "dpop": exchange_proof,
        },
    )
    assert exchange.status_code == 200, exchange.text
    assert exchange.json()["token_type"] == "DPoP"

    skill_options = options(keys, discovery)
    skill_options["skills"] = {"items": []}
    skill_app = FastAPI()
    init_fastapi(HOST, skill_options).register_routes(skill_app)
    skill_client = TestClient(skill_app, base_url=ORIGIN)
    assert skill_client.get("/.well-known/weldall-skills").status_code == 401


def test_fastapi_machine_principal(keys, discovery):
    weldall = init_fastapi(HOST, options(keys, discovery))
    app = FastAPI()
    weldall.install_exception_handler(app)

    @app.get("/private")
    def private(auth=Depends(weldall.require_auth({"scopes": ["read"]}))):
        return {"identity_type": auth.identity_type, "subject": auth.subject}

    now = int(time.time())
    token = sign_es256(
        {
            "iss": HOST,
            "sub": "machine:automation",
            "client_id": "automation",
            "azp": "automation",
            "aud": RESOURCE,
            "scope": "read",
            "identity_type": "machine",
            "token_type": "machine",
            "cnf": {"jkt": keys.machine["jkt"]},
            "iat": now,
            "exp": now + 300,
            "jti": str(uuid.uuid4()),
        },
        kid="w1",
        private_jwk=keys.issuer["private_jwk"],
        typ="weldall-machine+jwt",
    )
    proof = create_dpop_proof(
        **keys.machine,
        method="GET",
        url=f"{ORIGIN}/private",
        access_token=token,
    )
    client = TestClient(app, base_url=ORIGIN)
    assert client.get("/private").json() == {
        "error": "invalid_token",
        "error_description": "DPoP authorization required",
    }
    response = client.get("/private", headers={"authorization": f"DPoP {token}", "dpop": proof})
    assert response.json() == {
        "identity_type": "machine",
        "subject": "machine:automation",
    }


def test_django_middleware_views_and_urls(keys, discovery):
    weldall = init_django(HOST, options(keys, discovery))
    factory = RequestFactory()

    def view(request):
        auth = weldall.get_auth(request)
        return JsonResponse({"subject": auth.subject})

    middleware = weldall.middleware(
        view,
        protected_paths=["/private"],
        policy={"scopes": ["read"]},
    )
    missing = middleware(factory.get("/private", secure=True, HTTP_HOST="expenses.example"))
    assert missing.status_code == 401
    assert missing.headers["www-authenticate"] == 'DPoP error="invalid_token"'
    token, proof = user_artifacts(keys)
    request = factory.get(
        "/private",
        secure=True,
        HTTP_HOST="expenses.example",
        HTTP_AUTHORIZATION=f"DPoP {token}",
        HTTP_DPOP=proof,
    )
    success = middleware(request)
    assert success.status_code == 200
    assert json.loads(success.content) == {"subject": "adapter-user"}
    assert middleware(request).status_code == 401
    for claims, status in (
        ({"issuer": "https://wrong.example"}, 401),
        ({"resource": "https://wrong.example/resource"}, 401),
        ({"scopes": ["other"]}, 403),
    ):
        denied_token, denied_proof = user_artifacts(keys, **claims)
        denied_request = factory.get(
            "/private",
            secure=True,
            HTTP_HOST="expenses.example",
            HTTP_AUTHORIZATION=f"DPoP {denied_token}",
            HTTP_DPOP=denied_proof,
        )
        assert middleware(denied_request).status_code == status
    metadata = weldall.protected_resource_metadata(
        factory.get(
            "/.well-known/oauth-protected-resource",
            secure=True,
            HTTP_HOST="expenses.example",
        )
    )
    assert metadata.status_code == 200
    assert json.loads(metadata.content)["resource"] == RESOURCE
    method_rejected = weldall.protected_resource_metadata(
        factory.post(
            "/.well-known/oauth-protected-resource",
            secure=True,
            HTTP_HOST="expenses.example",
        )
    )
    assert method_rejected.status_code == 405
    assert method_rejected.headers["allow"] == "GET"
    for view in (
        weldall.authorization_server_metadata,
        weldall.jwks,
        weldall.skills,
    ):
        response = view(factory.post("/wrong-method"))
        assert response.status_code == 405
        assert response.headers["allow"] == "GET"
    token_method_rejected = weldall.token(factory.get("/oauth/token"))
    assert token_method_rejected.status_code == 405
    assert token_method_rejected.headers["allow"] == "POST"
    assertion = make_assertion(keys, scopes=["read"])
    exchange_proof = create_dpop_proof(
        **keys.device,
        method="POST",
        url=f"{ORIGIN}/oauth/token",
    )
    token_response = weldall.token(
        factory.post(
            "/oauth/token",
            data=urlencode(
                {
                    "grant_type": "urn:ietf:params:oauth:grant-type:jwt-dpop",
                    "assertion": assertion,
                }
            ),
            content_type="application/x-www-form-urlencoded",
            secure=True,
            HTTP_HOST="expenses.example",
            HTTP_DPOP=exchange_proof,
        )
    )
    assert token_response.status_code == 200, token_response.content
    assert json.loads(token_response.content)["token_type"] == "DPoP"
    patterns = weldall.urls()
    names = {pattern.name for pattern in patterns}
    assert {
        "weldall-authorization-server-metadata",
        "weldall-protected-resource-metadata",
        "weldall-jwks",
        "weldall-token",
    } <= names
    wildcard = next(
        pattern
        for pattern in patterns
        if pattern.name == "weldall-protected-resource-metadata-path"
    )
    assert wildcard.resolve(".well-known/oauth-protected-resource/api/expenses") is not None
    assert "weldall-skills" not in names

    skill_options = options(keys, discovery)
    skill_options["skills"] = {"items": []}
    skill_weldall = init_django(HOST, skill_options)
    assert "weldall-skills" in {pattern.name for pattern in skill_weldall.urls()}
    unauthorized_skills = skill_weldall.skills(
        factory.get(
            "/.well-known/weldall-skills",
            secure=True,
            HTTP_HOST="expenses.example",
        )
    )
    assert unauthorized_skills.status_code == 401


def test_get_auth_requires_middleware(keys, discovery):
    weldall = init_django(HOST, options(keys, discovery))
    request = RequestFactory().get("/")
    with pytest.raises(RuntimeError, match="middleware"):
        weldall.get_auth(request)
