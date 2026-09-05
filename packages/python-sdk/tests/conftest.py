from __future__ import annotations

from dataclasses import dataclass
from threading import Event
from urllib.parse import urlencode

import httpx
import pytest

from weldall import (
    JWT_DPOP_GRANT,
    Request,
    create_dpop_proof,
    generate_es256_key_pair,
    in_memory,
    init_weldall,
    issue_id_jag,
)

HOST = "https://weldall.example"
ORIGIN = "https://expenses.example"
RESOURCE = f"{ORIGIN}/api"
CLIENT_ID = "weldall-cli-at-expenses"


@dataclass
class Keys:
    issuer: dict
    local: dict
    device: dict
    machine: dict


@pytest.fixture
def keys() -> Keys:
    return Keys(
        issuer=generate_es256_key_pair(),
        local=generate_es256_key_pair(),
        device=generate_es256_key_pair(),
        machine=generate_es256_key_pair(),
    )


class DiscoveryState:
    def __init__(self, key: dict, kid: str = "w1") -> None:
        self.key = key
        self.kid = kid
        self.calls: list[str] = []
        self.metadata = {"issuer": HOST, "jwks_uri": f"{HOST}/api/oauth/jwks"}
        self.jwks_entered: Event | None = None
        self.jwks_release: Event | None = None

    def client(self) -> httpx.Client:
        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            self.calls.append(url)
            if url.endswith("/.well-known/oauth-authorization-server"):
                return httpx.Response(200, json=self.metadata)
            if url.endswith("/api/oauth/jwks"):
                if self.jwks_entered is not None:
                    self.jwks_entered.set()
                if self.jwks_release is not None:
                    assert self.jwks_release.wait(2)
                return httpx.Response(
                    200,
                    json={
                        "keys": [
                            {
                                **self.key["public_jwk"],
                                "kid": self.kid,
                                "alg": "ES256",
                                "use": "sig",
                            }
                        ]
                    },
                )
            return httpx.Response(404, json={})

        return httpx.Client(transport=httpx.MockTransport(handler))


@pytest.fixture
def discovery(keys: Keys) -> DiscoveryState:
    return DiscoveryState(keys.issuer)


def make_sdk(keys: Keys, discovery: DiscoveryState, **overrides):
    options = {
        "resource": RESOURCE,
        "public_origin": ORIGIN,
        "client_id": CLIENT_ID,
        "supported_scopes": ["read", "write", "admin", "expenses:read", "expenses:create"],
        "signing_key": {
            "kid": "local",
            "private_jwk": keys.local["private_jwk"],
            "public_jwk": keys.local["public_jwk"],
        },
        "replay_store": in_memory(suppress_warning=True),
        "_http_client": discovery.client(),
    }
    options.update(overrides)
    return init_weldall(HOST, options)


def make_assertion(keys: Keys, **overrides) -> str:
    values = {
        "issuer": HOST,
        "subject": "user-1",
        "email": "user@example.com",
        "audience": ORIGIN,
        "client_id": CLIENT_ID,
        "resource": RESOURCE,
        "scopes": ["read", "write"],
        "jkt": keys.device["jkt"],
        "kid": "w1",
        "private_jwk": keys.issuer["private_jwk"],
    }
    values.update(overrides)
    return issue_id_jag(**values)


def exchange(sdk, keys: Keys, assertion: str | None = None):
    proof = create_dpop_proof(
        **keys.device,
        method="POST",
        url=f"{ORIGIN}/oauth/token",
    )
    response = sdk.handlers.token(
        Request(
            "POST",
            f"{ORIGIN}/oauth/token",
            {
                "content-type": "application/x-www-form-urlencoded",
                "dpop": proof,
            },
            urlencode(
                {
                    "grant_type": JWT_DPOP_GRANT,
                    "assertion": assertion or make_assertion(keys),
                }
            ),
        )
    )
    return response, response.json_body()


def protected_request(
    token: str, keys: Keys, url: str = f"{ORIGIN}/api/expenses", method: str = "GET"
):
    proof = create_dpop_proof(
        **keys.device,
        method=method,
        url=url,
        access_token=token,
    )
    return Request(
        method,
        url,
        {"authorization": f"DPoP {token}", "dpop": proof},
    )
