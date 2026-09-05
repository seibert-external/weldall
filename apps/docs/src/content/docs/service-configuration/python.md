---
title: Integrate a Python service
description: Use the Weldall SDK with FastAPI to protect a contract API, or start from the Django example.
sidebar:
  label: Python
---

Weldall validates incoming requests to web services. We provide libraries you can add to your application to check who is making a request and whether they have the required permissions. These checks run before the application reads data or makes changes.

For Python, use `weldall-sdk`, which supports FastAPI and Django. This guide uses it with FastAPI to build a service that returns a contract list only with the `contracts:read` permission. The service also publishes a skill: instructions with the command an agent needs to call it.

You need Python 3.11 or newer, [uv](https://docs.astral.sh/uv/), and a running Weldall instance. The published package is [`weldall-sdk` on PyPI](https://pypi.org/project/weldall-sdk/). Its [source and reference](https://github.com/seibert-external/weldall/tree/main/packages/python-sdk) live alongside the TypeScript SDK in the Weldall repository.

## 1. Create the FastAPI project

```sh
uv init --bare --python 3.11 weldall-contracts
cd weldall-contracts
uv add 'weldall-sdk[fastapi]' uvicorn
```

If you manage dependencies with pip instead, install `weldall-sdk[fastapi]` and `uvicorn` in your virtual environment.

## 2. Protect the contract route

Create `app.py`:

```python
import os

from fastapi import Depends, FastAPI
from weldall import generate_es256_key_pair, in_memory
from weldall.adapters.fastapi import init_weldall

weldall_issuer = os.environ.get("WELDALL_ISSUER", "https://weldall.example.com")
public_origin = os.environ.get("PUBLIC_ORIGIN", "http://localhost:8000")
key = generate_es256_key_pair()

weldall = init_weldall(
    weldall_issuer,
    {
        "resource": f"{public_origin}/api",
        "public_origin": public_origin,
        "client_id": "weldall-cli-at-contracts",
        "supported_scopes": ["contracts:read"],
        "signing_key": {
            "kid": "development-only",
            "private_jwk": key["private_jwk"],
            "public_jwk": key["public_jwk"],
        },
        "replay_store": in_memory(),
        "skills": {
            "items": [
                {
                    "id": "list",
                    "title": "List contracts",
                    "requiredScopes": ["contracts:read"],
                    "visibility": "HIDDEN_IF_UNALLOWED",
                    "content": (
                        "# List contracts\n\nRun `weldall request --scope contracts:read "
                        f"{public_origin}/api/contracts`."
                    ),
                }
            ]
        },
        "allow_insecure_loopback": public_origin == "http://localhost:8000",
    },
)

app = FastAPI()
weldall.register_routes(app)


@app.get("/api/contracts")
def contracts(auth=Depends(weldall.require_auth({"scopes": ["contracts:read"]}))):
    return {
        "requested_by": auth.identity.subject,
        "contracts": [
            {"id": "contract-1001", "customer": "Nordstern GmbH", "status": "active"},
            {"id": "contract-1002", "customer": "Südwind AG", "status": "review"},
        ],
    }
```

`register_routes()` adds discovery, signing-key, token, and skill routes. The `require_auth()` dependency checks authorization before FastAPI calls the contract handler. The handler receives the verified identity as `auth`. How you map it to your own user records is up to your application.

Python options use names such as `public_origin` and `supported_scopes`. Skill fields such as `requiredScopes` keep their wire-format spelling. The skill's visibility setting hides it from employees without `contracts:read`; it does not replace the route's authorization check.

## 3. Check the service locally

Set `WELDALL_ISSUER` to your Weldall instance and start the service:

```sh
WELDALL_ISSUER=https://weldall.example.com \
PUBLIC_ORIGIN=http://localhost:8000 \
uv run uvicorn app:app --port 8000
```

In another terminal, check discovery and the protected route:

```sh
curl -i http://localhost:8000/.well-known/oauth-protected-resource
curl -i http://localhost:8000/api/contracts
```

Discovery returns `200` with the resource identifier `http://localhost:8000/api`. The contract request returns `401` because it has no Weldall authorization. These checks do not require a CLI login. You can also call `weldall.ready()` during startup to check issuer discovery and signing configuration before serving requests.

## 4. Deploy and register the service

:::caution[Replay protection across instances]
Each DPoP proof contains a unique ID (`jti`). The SDK stores used IDs and rejects reused proofs. With `in_memory()`, this only works within one process.

Proofs are short-lived, but another worker or instance can still accept the same proof within that window. To prevent replays across workers and instances, provide a shared replay store, for example backed by Redis. It must insert new IDs atomically, reject duplicates, and retain IDs until the validity window ends. See [Security](../../oauth-security/) for details.
:::

In production, use HTTPS and load your ES256 signing key from configuration rather than generating a new one on every start as the example does.

Deploy the service at `https://contracts.example.com` and set `PUBLIC_ORIGIN` to that exact URL. Keep `WELDALL_ISSUER` set to your Weldall instance. The resource identifier becomes `https://contracts.example.com/api`, and the skill uses the deployed URL.

Continue with [registration and permission assignment](../#for-weldall-administrators). Those steps are the same for TypeScript and Python.

## Examples on GitHub

- [FastAPI: `examples/python-fastapi`](https://github.com/seibert-external/weldall/tree/main/examples/python-fastapi)
- [Django: `examples/python-django`](https://github.com/seibert-external/weldall/tree/main/examples/python-django)

Each README lists the commands to run the example. Both examples protect `/api/expenses` with `expenses:read`, but do not publish skills.
