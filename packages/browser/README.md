# `@weldall/browser`

Browser-only ESM client for CLI-approved Weldall SPA connections. It has no Node runtime entry point, engine requirement, polyfill, or dependency on `@weldall/sdk`.

```ts
import { createWeldallBrowserClient, inspectWeldallBrowserSupport } from "@weldall/browser";

const support = await inspectWeldallBrowserSupport();
if (!support.supported) renderUnsupported(support.missingFeatures);

const weldall = await createWeldallBrowserClient({
  issuer: "https://weldall.example.com",
  resource: "https://expenses.example.com/api",
});

const status = await weldall.getConnectionStatus({ verify: "local" });
if (status.state === "disconnected") {
  const pairing = await weldall.connect({ method: "cli-code" });
  console.log(`Run: weldall connect ${pairing.userCode}`);
  await pairing.connected;
}

const response = await weldall.request("https://expenses.example.com/api/expenses", {
  method: "GET",
  scopes: ["expenses:read"],
});
```

`getConnectionStatus({ verify: "local" })` never performs network I/O or rotates a token. Remote verification, refresh, disconnect, and local clearing serialize through `navigator.locks`. `disconnect()` clears local credentials only after successful or terminal remote revocation; transient failures preserve them for retry. `clearLocalConnection()` is deliberately local-only recovery.

## Required browser capabilities

The package feature-detects a secure context, WebCrypto P-256 generation/signing, a non-exportable private key, public JWK export, IndexedDB structured cloning and reload of the key, Fetch/URL/TextEncoder/AbortController/random APIs, and `navigator.locks`. `createWeldallBrowserClient()` performs this probe before discovery, storage, or network access and throws `WeldallBrowserUnsupportedError` with stable capability codes. The CI suite currently pins Playwright 1.61.1 browser revisions: Chrome for Testing 149.0.7827.55, Firefox 151.0, and WebKit 26.5. These are tested capabilities rather than a user-agent allowlist; newer compatible browsers pass through feature detection. Private/incognito modes can fail the persistence probe.

## Security boundary

The P-256 private `CryptoKey` is generated with `extractable: false` and only its public JWK is exported. The key and rotating refresh token are persisted in schema-versioned IndexedDB, isolated by issuer and resource; the matching `navigator.locks` namespace serializes rotation across tabs. Weldall access tokens, ID-JAGs, and downstream access tokens remain memory-only. Every token operation and API call gets a fresh exact-URL/method DPoP proof, including `ath` where required. Redirects, percent-encoded request paths, and credentialed-cookie fetches are refused.

Non-exportability prevents raw key export through WebCrypto. It does **not** prevent malicious same-origin JavaScript from asking the key to sign. Deploy the SPA only over HTTPS with a strict Content Security Policy, controlled third-party scripts, reviewed dependencies, lockfile integrity, and prompt security patching.

## Expenses local development fixture

The workspace package is consumed directly by the development-only Expenses page; no global link or publication is needed:

```sh
pnpm build:dev
pnpm dev
# second terminal
caddy run --config Caddyfile
# after repository CLI login
./apps/cli/dist/index.js connect ABCD-EFGH
```

Open `https://expenses.seibert.localdev/weldall-browser`, start a connection, and copy the exact command it displays. The page shows capability failures, local and remote status, Weldall subject, read/create results, disconnect, and local-only recovery. Root `pnpm dev` includes the browser package watcher, while the Expenses server serves its emitted ESM modules. The page returns 404 when `NODE_ENV=production`. The Docker system test opts the compiled production Expenses server in explicitly with `WELDALL_BROWSER_FIXTURE_ENABLED=true` and serves the SDK from an extracted packed npm tarball; ordinary production deployments must never set that variable.

CORS failures normally mean the current Expenses origin, resource, or browser client no longer matches Weldall; refresh/revocation failures remain visible and do not silently clear retryable local credentials. Private/incognito mode may fail the IndexedDB key-cloning probe. Keep the local Caddy CA trusted and do not bypass HTTPS, CSP, or dependency review to make the fixture work.

## Development and verification

```sh
pnpm --filter @weldall/browser typecheck
pnpm --filter @weldall/browser test
pnpm --filter @weldall/browser pack:check
pnpm --filter @weldall/browser test:browser # real Chromium, Firefox, WebKit; CI-owned
```

`pack:check` scans emitted code for Node runtime symbols, bundles with esbuild `platform=browser` and no polyfills, checks the metafile for built-ins, installs the packed tarball into a clean Vite fixture, and production-builds it. The Playwright suite serves that packed fixture's production output (not workspace source or a Vite development server) in all three browser engines.
