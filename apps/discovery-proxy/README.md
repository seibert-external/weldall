# Weldall discovery proxy

A minimal reverse proxy for resources that must validate Weldall ID-JAGs but cannot connect to the Weldall issuer directly.

The image exposes only these unauthenticated public endpoints:

- `GET /.well-known/oauth-authorization-server`
- `GET /api/oauth/jwks`

All other paths return `404`. On the two exposed paths, non-GET requests return `405` and requests with query parameters return `404`. JSON response bodies are forwarded unchanged so resource servers can continue validating the canonical issuer and JWKS location.

## Build

From the repository root:

```sh
pnpm --filter @weldall/discovery-proxy image:build
```

## Run

`WELDALL_UPSTREAM` is required and must be an HTTPS origin without a path, query, fragment, or credentials.

```sh
docker run --rm -p 8080:8080 \
  -e WELDALL_UPSTREAM=https://weldall.example.com \
  weldall-discovery-proxy:local
```

Terminate HTTPS for the proxy at the deployment ingress. Configure the resource SDK with the canonical Weldall issuer and the externally reachable proxy origin:

```ts
initWeldall("https://weldall.example.com", {
  discoveryProxyOrigin: "https://publicproxy.weldall.io",
  // remaining resource options
});
```

The proxy verifies the upstream TLS certificate and sends SNI for the configured upstream. It does not cache responses; the SDK retains its normal short-lived JWKS cache and key-rotation behavior.
