# Astro 7 SSR example

This on-demand-rendered Node SSR example uses middleware, `context.locals`, and endpoint handlers that always return `Response`. Run `pnpm build && pnpm start`.

The generated key, loopback HTTP, and in-memory replay store are development-only. Production requires HTTPS, durable KMS/Vault signing, and a shared atomic replay store.

## Troubleshooting

- Use the Node adapter with `output: "server"`; static prerendering cannot provide request authentication.
- Declare `weldallAuth` in `App.Locals` and call `getAuth(context)` only behind the SDK middleware.
- A 401 commonly means the externally visible URL differs from the DPoP proof; a 403 means the scope policy failed.
