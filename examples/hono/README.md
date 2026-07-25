# Hono example

Run `pnpm build && pnpm start`, then configure Weldall for `http://localhost:8787/api`. The example registers discovery/token/JWKS routes and protects `/api/expenses`.

The ephemeral key, loopback HTTP, and `inMemory()` store are development-only. Production requires HTTPS, persistent signing/KMS, and a shared atomic replay store.

## Troubleshooting

- A 401 with `invalid_token` or `invalid_dpop_proof` usually indicates a mismatched public URL, token audience, or reused proof.
- A 403 with `insufficient_scope` means the route's `scopes`/`anyScopes` policy was not satisfied.
- Call `getAuth(c)` only after `protect(...)`; otherwise no verified request-local identity exists.
