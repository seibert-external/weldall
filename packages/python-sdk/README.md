# weldall-sdk

`weldall-sdk` adds Weldall authentication to Python resource servers. It verifies
DPoP-bound user and machine requests, provides Weldall's OAuth protocol endpoints,
publishes resource skills, and includes FastAPI and Django adapters. The protocol
behavior is kept interoperable with the authoritative TypeScript `@weldall/sdk`.

## Installation

Python 3.11 or newer is required.

```sh
pip install weldall-sdk                    # framework-neutral core
pip install 'weldall-sdk[fastapi]'         # FastAPI adapter
pip install 'weldall-sdk[django]'          # Django adapter
```

## Framework-neutral core

Create one SDK instance when the service starts. The generated key and in-memory
replay store below are development-only.

```python
from weldall import Request, generate_es256_key_pair, in_memory, init_weldall

key = generate_es256_key_pair()
weldall = init_weldall(
    "https://weldall.example.com",
    {
        "resource": "https://contracts.example.com/api",
        "public_origin": "https://contracts.example.com",
        "client_id": "weldall-cli-at-contracts",
        "supported_scopes": ["contracts:read"],
        "signing_key": {
            "kid": "development-only",
            "private_jwk": key["private_jwk"],
            "public_jwk": key["public_jwk"],
        },
        "replay_store": in_memory(),
    },
)

weldall.ready()  # optional fail-fast discovery and signing-key validation

auth = weldall.verify(
    Request("GET", public_url, request_headers),
    {"scopes": ["contracts:read"]},
)
print(auth.identity.type, auth.subject, auth.scopes)
```

`verify()` raises `WeldallAuthError`. `verify_no_throw()` instead returns a
`VerifyResult` containing either `auth`, or `error` and a framework-neutral OAuth
`Response`. Every scope in `scopes` is required; when `any_scopes` is non-empty,
at least one of those scopes is required too. An empty policy still authenticates
the request.

The handlers are:

| Route                                         | Handler                                  |
| --------------------------------------------- | ---------------------------------------- |
| `GET /.well-known/oauth-authorization-server` | `handlers.authorization_server_metadata` |
| `GET /.well-known/oauth-protected-resource`   | `handlers.protected_resource_metadata`   |
| `GET /.well-known/oauth-protected-resource/*` | `handlers.protected_resource_metadata`   |
| `GET /.well-known/jwks.json`                  | `handlers.jwks`                          |
| `GET /.well-known/weldall-skills`             | `handlers.skills` (when configured)      |
| `POST /oauth/token`                           | `handlers.token`                         |

## FastAPI

```python
from fastapi import Depends, FastAPI, Request
from weldall.adapters.fastapi import init_weldall

weldall = init_weldall("https://weldall.example.com", options)
app = FastAPI()
weldall.register_routes(app)


@app.get("/api/contracts")
def contracts(
    request: Request,
    auth=Depends(weldall.require_auth({"scopes": ["contracts:read"]})),
):
    # The dependency also stores the same value on request.state.
    assert weldall.get_auth(request) == auth
    return {"requested_by": auth.subject, "contracts": []}
```

`register_routes()` mounts the complete protocol surface and installs the exception
handler that preserves the core OAuth body. If an application uses
`require_auth()` without registering protocol routes, call
`weldall.install_exception_handler(app)` once.

## Django

The adapter exposes protocol views/URL patterns and middleware for selected paths.
A project can include `weldall.urls()` in its root URL configuration.

```python
from django.urls import include, path
from weldall.adapters.django import init_weldall

weldall = init_weldall("https://weldall.example.com", options)
urlpatterns = [path("", include(weldall.urls()))]
```

Wrap protected views directly, or construct the same middleware from a Django
middleware factory:

```python
protected = weldall.middleware(
    application_view,
    protected_paths=["/api"],
    policy={"scopes": ["contracts:read"]},
)

# Inside application_view after middleware succeeded:
auth = weldall.get_auth(request)
```

The constructor form is
`WeldallMiddleware(get_response, weldall, protected_paths=[...], policy=...)`.
This explicit instance injection avoids global SDK state and lets Django projects
choose one SDK instance per resource configuration.

## Machine-to-machine calls

```python
import os

from weldall import (
    calculate_jwk_thumbprint,
    load_es256_key_pair_from_env,
    request_machine_token,
)

private_jwk, public_jwk = load_es256_key_pair_from_env(
    "MACHINE_SIGNING_PRIVATE_JWK",
    os.environ.get("MACHINE_SIGNING_PRIVATE_JWK"),
    "MACHINE_SIGNING_PUBLIC_JWK",
    os.environ.get("MACHINE_SIGNING_PUBLIC_JWK"),
)
key = {
    "private_jwk": private_jwk,
    "public_jwk": public_jwk,
    "jkt": calculate_jwk_thumbprint(public_jwk),
}
result = request_machine_token(
    issuer="https://weldall.example.com",
    client_id="expenses-a",
    resource="https://expenses-b.example.com/api",
    scopes=["expenses-b:read"],
    kid=os.environ["MACHINE_SIGNING_KID"],
    key=key,
)
```

The result uses OAuth/Python snake-case keys: `access_token`, `token_type`,
`expires_in`, and `scope`. The normal resource `verify()` method accepts both user
`at+jwt` tokens and `weldall-machine+jwt` tokens and returns a discriminated
`auth.identity.type`.

## Publishing skills

Configure exactly one static `items` list or synchronous `load` callable:

```python
"skills": {
    "items": [
        {
            "id": "list",
            "title": "List contracts",
            "requiredScopes": ["contracts:read"],
            "visibility": "HIDDEN_IF_UNALLOWED",
            "content": "# List contracts\n\nUse the contracts API.",
            "meta": {"tags": ["contracts"], "owner": "Legal Operations"},
        }
    ]
}
```

Catalogs are strictly validated, limited to 100 skills and 1 MiB, and require
replay protection because Weldall fetches them with one-use signed assertions.

## Signing providers

A direct `signing_key` contains `kid`, `private_jwk`, and `public_jwk`. KMS/Vault
integrations can instead provide synchronous `current()` and `jwks()` methods.
`current()` returns a key with `kid`, `public_jwk`, and
`sign(payload, protected_header)`. Before returning any token, the SDK verifies
that the active key is published, verifies the returned ES256 signature and exact
header, and deep-compares the returned claims to the requested claims.

## Intentional Python API deviations

Protocol values, validation order, claims, errors, cache behavior, and replay
behavior match `@weldall/sdk`. The language/framework-only differences are:

- Public functions, fields, and option keys use `snake_case`; wire-format JWT,
  OAuth, and skill-catalog keys remain unchanged.
- The core, replay store, discovery, machine client, and signing-provider contracts
  are synchronous. `httpx.Client` is injectable as `http_client` for the machine
  client; FastAPI only awaits request-body collection before calling the sync core.
- `Request`, `Response`, and the discriminated `VerifyResult` dataclasses replace
  the JavaScript Fetch classes. Registry normalization returns canonical URL strings
  instead of JavaScript `URL` objects.
- `load_es256_key_pair_from_env()` returns `(private_jwk, public_jwk)`; generated
  DPoP key pairs use a typed mapping with `private_jwk`, `public_jwk`, and `jkt`.
- FastAPI stores auth in `request.state.weldall_auth`; Django stores it as
  `request.weldall_auth`. Django middleware receives the configured SDK instance
  explicitly rather than relying on process-global settings.
- Framework registration APIs naturally follow FastAPI/Django routing conventions;
  JavaScript-only Hono, Next.js, and Astro adapters are not reproduced.

## Production checklist

- Load a stable ES256 signing key; generating one at startup invalidates tokens.
- Keep `resource`, `public_origin`, protocol routes, and Weldall registration exact.
- Use HTTPS. `allow_insecure_loopback=True` is only for local loopback development.
- Use a shared atomic replay store when horizontally scaled. `in_memory()` is
  process-local; `replay_store="disabled"` explicitly accepts replay risk and
  cannot be used with skill publication.
- Call `ready()` at startup when discovery and JWKS availability must fail early.
- Plan key rotation, short token lifetimes, and the current lack of DPoP nonce
  negotiation.

## Development and packaging

```sh
uv sync --locked --all-extras
uv run ruff format --check .
uv run ruff check .
uv run mypy src tests/typing
uv run pytest
uv build
```

The wheel and sdist include `LICENSE` and `py.typed`. Publishing is intentionally
not part of local development. The manual trusted-publishing workflow requires an
explicitly authorized `weldall-sdk-vX.Y.Z` tag and a protected environment; publish
to TestPyPI first, then separately authorize PyPI.

## License

FSL-1.1-ALv2 (Functional Source License), converting to Apache-2.0 two years after
each release. PyPI may display this nonstandard SPDX identifier as “Other”; the
complete byte-identical license text is included in every distribution.
