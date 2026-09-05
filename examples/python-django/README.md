# Django example (Python SDK)

Run:

```sh
uv sync
uv run python manage.py runserver 8000
```

Then register the resource `http://localhost:8000/api` in Weldall. The example
mounts the full protocol surface (discovery, JWKS, token, skills) via
`weldall.urls()` and protects `/api/expenses` with
`weldall.middleware(...)` and `{"scopes": ["expenses:read"]}`.

The ephemeral key, loopback HTTP, and `in_memory()` replay store are
development-only. Production requires HTTPS, a persistent ES256 signing key (or
KMS/Vault provider), and a shared atomic replay store.

## Using the published package

This example depends on `weldall-sdk[django]` from PyPI. The `[tool.uv.sources]`
override points at the local `packages/python-sdk` checkout for in-repo
development; consumers install it normally:

```sh
pip install 'weldall-sdk[django]'
```

## Troubleshooting

- A 401 with `invalid_token` or `invalid_dpop_proof` usually indicates a
  mismatched public URL, token audience, or reused proof.
- A 403 with `insufficient_scope` means the route's `scopes`/`any_scopes`
  policy was not satisfied.
- `temporarily_unavailable` fails closed when discovery, JWKS, signing, or
  replay storage is unavailable.
- Call `get_auth(request)` only inside a view after the middleware ran;
  otherwise no verified request-local identity exists.
