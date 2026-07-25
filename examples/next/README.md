# Next.js 16 example

This App Router example explicitly exports `runtime = "nodejs"`, passes `auth` as a handler argument, and mounts the SDK Fetch handlers. Run `pnpm build && pnpm start`.

The explicitly public checked-in example key, loopback HTTP, and in-memory replay store are development-only. Use HTTPS, durable KMS/Vault signing, and shared atomic replay storage in production.

## Troubleshooting

- Every SDK route must use `runtime = "nodejs"`; Edge is intentionally unsupported in V1.
- A 401 commonly means the proof URL does not match the externally visible route origin/path or the local token claims.
- Keep both protected-resource metadata routes (`/.well-known/oauth-protected-resource` and its `/api` variant) when the resource identifier ends in `/api`.
