from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

from weldall import (
    create_dpop_proof,
    generate_es256_key_pair,
    issue_access_token,
    normalize_htu,
    sign_es256,
    verify_access_token,
    verify_es256,
    verify_strict_dpop,
)

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = "packages/python-sdk/tests/fixtures/interop.ts"
ISSUER = "https://interop.example"
RESOURCE = "https://interop.example/api"
CLIENT_ID = "interop-client"
URL = "https://INTEROP.example:443/api/a//../items?ignored=yes"


def node(mode: str, data: dict | None = None) -> dict:
    result = subprocess.run(
        ["pnpm", "exec", "tsx", SCRIPT, mode],
        cwd=ROOT,
        input=json.dumps(data) if data is not None else None,
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout)


def test_whatwg_url_normalization_matches_node():
    urls = [
        "https:faß.de/a[b|c]?ignored=yes",
        "http://127.1/a",
        "https://[::ffff:127.0.0.1]/a",
        "https://a..com/a",
        "https://example.com/a%5Bb%7Cc%5D",
    ]
    assert [normalize_htu(value) for value in urls] == node("normalize", {"urls": urls})["urls"]


def test_node_artifacts_verify_in_python():
    artifact = node("generate")
    generic = verify_es256(
        artifact["genericJwt"],
        issuer=ISSUER,
        audience=RESOURCE,
        kid="node-signing",
        public_jwk=artifact["signingPublicJwk"],
    )
    assert generic["source"] == "node"
    token = verify_access_token(
        artifact["accessToken"],
        issuer=ISSUER,
        resource=RESOURCE,
        client_id=CLIENT_ID,
        kid="node-signing",
        public_jwk=artifact["signingPublicJwk"],
        required_scopes=["interop:read"],
    )
    assert token["sub"] == "interop-user"
    proof = verify_strict_dpop(
        artifact["proof"],
        method="GET",
        url=URL,
        replay="disabled",
        access_token=artifact["accessToken"],
        expected_jkt=artifact["deviceJkt"],
    )
    assert proof.jkt == artifact["deviceJkt"]


def test_python_artifacts_verify_in_node():
    signing = generate_es256_key_pair()
    device = generate_es256_key_pair()
    now = int(time.time())
    access_token = issue_access_token(
        issuer=ISSUER,
        subject="interop-user",
        email="interop@example.com",
        resource=RESOURCE,
        client_id=CLIENT_ID,
        scopes=["interop:read"],
        jkt=device["jkt"],
        kid="python-signing",
        private_jwk=signing["private_jwk"],
        now=now,
    )
    generic = sign_es256(
        {"iss": ISSUER, "aud": RESOURCE, "iat": now, "exp": now + 300, "source": "python"},
        kid="python-signing",
        private_jwk=signing["private_jwk"],
    )
    proof = create_dpop_proof(
        **device,
        method="GET",
        url=URL,
        access_token=access_token,
        now=now,
        jti="python-proof",
    )
    result = node(
        "verify",
        {
            "signingPublicJwk": signing["public_jwk"],
            "devicePublicJwk": device["public_jwk"],
            "deviceJkt": device["jkt"],
            "accessToken": access_token,
            "genericJwt": generic,
            "proof": proof,
        },
    )
    assert result == {"ok": True}
