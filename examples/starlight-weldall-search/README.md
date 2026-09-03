# @weldall/example-starlight-weldall-search

Minimal Starlight site (SSR, `@astrojs/node`) that demonstrates
`@weldall/sdk/starlight`. Content lives in
`src/content/docs/` with German text so stemming is visible.

## Run

```sh
# the SDK must be built first (turbo does this automatically)
pnpm --filter @weldall/sdk build
pnpm --filter @weldall/example-starlight-weldall-search build
pnpm --filter @weldall/example-starlight-weldall-search start
```

The integration options in `astro.config.mjs` use a loopback origin, so
`allowInsecureLoopback` is enabled automatically for local dev.

## Verify

```sh
# resource metadata
curl -s http://localhost:4321/.well-known/oauth-protected-resource

# search without a token -> 401
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:4321/api/search?q=umsatz"
# -> 401

# skill catalog requires a skill assertion -> 401 without one
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4321/.well-known/weldall-skills
# -> 401
```

An authenticated request needs a valid `DPoP` access token (issued for the
`resource`/`search:read` scope by the Weldall platform) plus a fresh DPoP
proof per request. See the Starlight section of `packages/sdk/README.md`.
