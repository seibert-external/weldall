"""Weldall FastAPI example resource server.

Run locally:

    uv run uvicorn app:app --reload --port 8000

Then register this resource in Weldall as ``http://localhost:8000/api`` and
configure the issuer URL used below. The example serves the full OAuth protocol
surface (discovery, JWKS, skills, token) and protects ``/api/expenses``.

The ephemeral key, loopback HTTP, and ``in_memory()`` replay store are
development-only. Production requires HTTPS, a persistent ES256 signing key (or
KMS/Vault provider), and a shared atomic replay store.
"""

from fastapi import Depends, FastAPI
from fastapi import Request as FastAPIRequest

from weldall import generate_es256_key_pair, in_memory
from weldall.adapters.fastapi import init_weldall

# Development-only: generate a stable key at startup in production, otherwise
# every restart invalidates previously issued tokens.
key = generate_es256_key_pair()

weldall = init_weldall(
    "https://weldall.example.com",
    {
        "resource": "http://localhost:8000/api",
        "public_origin": "http://localhost:8000",
        "client_id": "weldall-cli-at-python-fastapi",
        "supported_scopes": ["expenses:read"],
        "signing_key": {
            "kid": "development-only",
            "private_jwk": key["private_jwk"],
            "public_jwk": key["public_jwk"],
        },
        "replay_store": in_memory(),
        "allow_insecure_loopback": True,
    },
)

app = FastAPI()
weldall.register_routes(app)


@app.get("/api/expenses")
def expenses(
    request: FastAPIRequest,
    auth=Depends(weldall.require_auth({"scopes": ["expenses:read"]})),
):
    # The dependency also stores the same value on request.state.
    assert weldall.get_auth(request) == auth
    return {
        "requested_by": auth.subject,
        "identity_type": auth.identity.type,
        "expenses": [],
    }
