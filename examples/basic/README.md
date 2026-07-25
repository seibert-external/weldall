# Basic Fetch example

```sh
pnpm install
pnpm build
```

This framework-neutral example exports configured `verify(request)` and `verifyNoThrow(request)` functions. It generates an ephemeral signing key and uses process-local replay storage **only for development**. Production deployments must supply a persistent ES256 signer (or KMS/Vault provider) and a shared atomic `ReplayStore`. `replayStore: "disabled"` is unsafe and must not be used in production.

## Troubleshooting

- `invalid_token` means the local access token, issuer, audience, client ID, or DPoP binding did not validate.
- `invalid_dpop_proof` usually means the public URL/method differs from the proof or a proof was replayed.
- `temporarily_unavailable` fails closed when discovery, JWKS, signing, or replay storage is unavailable.
