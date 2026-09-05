"""Weldall Django example resource server.

Run locally:

    uv run python manage.py runserver 8000

Then register this resource in Weldall as ``http://localhost:8000/api`` and
configure the issuer URL used below. The example mounts the full OAuth protocol
surface (discovery, JWKS, skills, token) via ``weldall.urls()`` and protects
``/api/expenses`` with the explicit middleware wrapper.

The ephemeral key, loopback HTTP, and ``in_memory()`` replay store are
development-only. Production requires HTTPS, a persistent ES256 signing key (or
KMS/Vault provider), and a shared atomic replay store.
"""

from django.http import JsonResponse

from weldall import generate_es256_key_pair, in_memory
from weldall.adapters.django import init_weldall

# Development-only: generate a stable key at startup in production, otherwise
# every restart invalidates previously issued tokens.
key = generate_es256_key_pair()

weldall = init_weldall(
    "https://weldall.example.com",
    {
        "resource": "http://localhost:8000/api",
        "public_origin": "http://localhost:8000",
        "client_id": "weldall-cli-at-python-django",
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


def _expenses(request):
    # Set by the middleware below after successful verification.
    auth = weldall.get_auth(request)
    return JsonResponse(
        {
            "requested_by": auth.subject,
            "identity_type": auth.identity.type,
            "expenses": [],
        }
    )


expenses = weldall.middleware(
    _expenses,
    protected_paths=["/api/expenses"],
    policy={"scopes": ["expenses:read"]},
)
