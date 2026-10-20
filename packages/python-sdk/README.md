# weldall-sdk

A Python service should not read data merely because an agent can reach its API.
`weldall-sdk` checks the employee or machine behind each request before application
code runs. It also serves the OAuth routes that connect the service to Weldall and
can publish instructions for agents.

The package follows the same protocol as the TypeScript `@weldall/sdk`. It includes
a framework-neutral core and adapters for FastAPI and Django.

## Install the SDK

The SDK requires Python 3.11 or newer.

```sh
pip install weldall-sdk                    # framework-neutral core
pip install 'weldall-sdk[fastapi]'         # FastAPI adapter
pip install 'weldall-sdk[django]'          # Django adapter
```

## Protect requests without a framework

Create one SDK instance when the service starts. The example generates a temporary
key and keeps replay data in memory. Use both choices only during development.

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

## Protect FastAPI routes

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

## Protect Django paths

The adapter provides protocol views, URL patterns, and middleware for selected
paths. Include `weldall.urls()` in the root URL configuration.

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

## Native MCP (unreleased)

The development SDK can serve ordinary MCP tools and fixed resources alongside HTTP. No separate
MCP runtime is required; protocol/JSON Schema dependencies already used by the SDK are reused.
Add `mcp` to the same options used by core, FastAPI or Django:

```python
from weldall.native_mcp import create_native_mcp


async def whoami(arguments, context):
    return {"content": [{"type": "text", "text": context.auth.subject}]}


mcp = create_native_mcp(
    path="/api/mcp",
    description="Contracts visible to the authenticated caller",
    discovery_scopes=["contracts:read"],
    tools=[
        {
            "name": "whoami",
            "inputSchema": {"type": "object", "additionalProperties": False},
            "scopes": ["contracts:read"],
            "annotations": {"readOnlyHint": True},
            "handler": whoami,
        }
    ],
)
options["mcp"] = mcp
# Initialize the existing core/framework SDK with these options.
```

FastAPI `register_routes()` and Django `urls()` mount the configured endpoint. Framework-neutral
users await `weldall.handlers.mcp(request)`. Catalogs are immutable; replace the provider/restart
to change definitions. Metadata advertises the endpoint, all discovery scopes and catalog revision.
The endpoint must remain inside the registered resource’s HTTPS origin and approved request prefixes.

Discovery and every operation require explicit nonempty supported scopes; all listed scopes are
required. Initialization/listing authenticates, and call/read additionally enforces operation scopes.
Handlers receive verified user/machine identity and must enforce record-level business permissions.
The transport is stateless Streamable HTTP with JSON responses, bounded messages and async
cancellation. There are no sessions, Apps, resource templates, automatic retries or write replay.
Cancellation cannot undo a completed write. Resource owners must audit business operations;
central token activity does not audit direct MCP calls. Existing local token verification retains
its user ten-minute/machine five-minute revocation window.

Removing `mcp` disables advertisement and MCP without changing HTTP. Full cross-SDK/framework,
installed-host and real-pilot acceptance remains pending; this section does not claim a released version.

## Call another service as a machine

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

### Call shared MCP connections as a machine

Provision a shared service-account key in the admin UI and assign `weldall:mcp` plus every connector/use scope. Request a token for Weldall itself, not a downstream resource:

```python
import asyncio
from weldall import request_machine_token, create_weldall_mcp_client

token = request_machine_token(
    issuer=issuer,
    client_id=client_id,
    kid=kid,
    key=key,
    resource=f"{issuer}/api",
    scopes=["weldall:mcp", "atlassian-mcp:use-shared"],
)


async def main():
    mcp = create_weldall_mcp_client(issuer=issuer, access_token=token["access_token"], key=key)
    target = {"connector_key": "atlassian-mcp", "connection": "production-bot"}
    await mcp.list_tools(**target)
    await mcp.call_tool(**target, name="TOOL_NAME", arguments={})


asyncio.run(main())
```

Use a stable shared connection key and discovered names/arguments. Also available: `list_connectors`, `list_connections`, `list_resources` and `read_resource(connector_key=..., connection=..., uri=...)`. All MCP methods require `await`; other SDK APIs remain synchronous.

Each request uses a fresh DPoP proof and validates shared contracts (including depth/node/URI/base64 limits): discovery 20 seconds, operations 30 seconds including connection, headers and body; requests/definitions 1 MiB, results 10 MiB. No retries: writes may already have executed. `WeldallMcpError` exposes sanitized code/status. Tokens/keys stay in memory; authorization is checked live. Machines cannot start OAuth or provision secrets. An optional `http_client` must be an `httpx.AsyncClient` on the same event loop, closed by its caller. Cancellation propagates as `asyncio.CancelledError` and closes the active response.

After TypeScript contract changes, regenerate with `pnpm --filter @weldall/sdk exec tsx scripts/export-mcp-contracts.ts`; TypeScript freshness and Python interoperability tests check the shared artifact.

## Publish instructions for agents

A service can publish the commands that an agent needs for its API. Configure
exactly one static `items` list or synchronous `load` callable:

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

Skills may include `mcpDependencies` with camelCase wire keys, e.g. `[{"connectorKey": "atlassian-mcp", "tools": ["getJiraIssue"], "includeResources": False}]`; `SkillMcpDependency` is exported for typing. Limit: eight distinct connectors and 32 tools each; empty tools require `includeResources: True`. The SDK sorts connectors/deduplicates and sorts tools without mutating input, and omits empty dependencies. References may precede connector/scope creation; Weldall checks visibility/access, and the SDK does not provision connectors or credentials.

## Use managed signing keys

A direct `signing_key` contains `kid`, `private_jwk`, and `public_jwk`. A service
that keeps keys in a KMS or Vault can instead provide synchronous `current()` and
`jwks()` methods.
`current()` returns a key with `kid`, `public_jwk`, and
`sign(payload, protected_header)`. Before returning any token, the SDK verifies
that the active key is published, verifies the returned ES256 signature and exact
header, and deep-compares the returned claims to the requested claims.

## Where the Python API differs

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

## Prepare a production service

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

The wheel and sdist include `LICENSE` and `py.typed`. Local development never
publishes a package. The manual release workflow accepts only an explicitly
authorized `weldall-sdk-vX.Y.Z` tag and runs through a protected environment.
Publish to TestPyPI first. Authorize PyPI in a separate run after checking the
result.

## License

FSL-1.1-ALv2 (Functional Source License), converting to Apache-2.0 two years after
each release. PyPI may display this nonstandard SPDX identifier as “Other”; the
complete byte-identical license text is included in every distribution.
