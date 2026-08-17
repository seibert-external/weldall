# Expenses development resource

Expenses is the Hono resource-server fixture for `@weldall/sdk`. It exposes the same DPoP-protected API routes to the CLI and browser client:

- `GET /api/expenses` — `expenses:read`
- `POST /api/expenses` — `expenses:create`
- `DELETE /api/expenses/:id` — `expenses:delete` and `expenses:write`

In non-production processes, `GET /weldall-browser` serves the `@weldall/browser` integration fixture. Build and run it from the repository root:

```sh
pnpm build:dev
pnpm dev
caddy run --config Caddyfile
```

Open `https://expenses.seibert.localdev/weldall-browser`, start a connection, then approve the displayed code with the built repository CLI. The page visibly reports browser capability, origin, CORS, permission, refresh, network, and revocation failures and provides separate remote disconnect and local-only reset actions.

The page and its module routes return 404 when `NODE_ENV=production`. The isolated Docker system test is the only exception: it sets `WELDALL_BROWSER_FIXTURE_ENABLED=true` and `WELDALL_BROWSER_DIST_DIR` to an extracted packed npm tarball while running the compiled Expenses server. Never set either variable in an ordinary production deployment. Development serves the browser workspace's emitted ESM directly, so the root browser watcher is required. The page uses a strict CSP and credentialless fetches. Keep third-party script use controlled, review dependency changes, and use HTTPS; a non-exportable WebCrypto key does not prevent malicious same-origin script from requesting signatures.
