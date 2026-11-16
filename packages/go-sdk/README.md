# Weldall Go SDK

A Go service should not read data merely because an agent can reach its API.
This package checks the employee or machine behind each request before
application code runs. It also serves the OAuth routes that connect the service
to Weldall, can publish instructions for agents, and lets a Go service call
another Weldall-protected service as a machine.

The package follows the same protocol as the TypeScript `@weldall/sdk`, which is
its behaviour reference. It builds on `net/http` only, so it works with the
standard `ServeMux` and with any router that accepts an `http.Handler`.

## Install the SDK

The SDK requires Go 1.26 or newer.

```sh
go get github.com/seibert-external/weldall/packages/go-sdk
```

```go
import weldall "github.com/seibert-external/weldall/packages/go-sdk"
```

## Protect a service

Create one `Weldall` when the service starts. The signing key must be stable per
stage — load it from your secret store; the SDK never generates one.

```go
private, public, err := weldall.LoadES256KeyPairFromEnv(
	"WELDALL_SIGNING_PRIVATE_JWK", os.Getenv("WELDALL_SIGNING_PRIVATE_JWK"),
	"WELDALL_SIGNING_PUBLIC_JWK", os.Getenv("WELDALL_SIGNING_PUBLIC_JWK"),
)
if err != nil {
	log.Fatal(err)
}
replay, err := weldall.InMemory(weldall.InMemoryOptions{}) // single replica only
if err != nil {
	log.Fatal(err)
}
w, err := weldall.New("https://weldall.example.com", weldall.Options{
	Resource:        "https://contracts.example.com/api",
	PublicOrigin:    "https://contracts.example.com",
	ClientID:        "weldall-cli-at-contracts",
	SupportedScopes: []string{"contracts:read"},
	SigningKey:      &weldall.DirectSigningKey{Kid: os.Getenv("WELDALL_SIGNING_KID"), Private: private, Public: public},
	ReplayStore:     replay,
})
if err != nil {
	log.Fatal(err)
}
if err := w.Ready(ctx); err != nil { // fetch Weldall's keys now, not on the first request
	log.Fatal(err)
}

mux := http.NewServeMux()
w.RegisterRoutes(mux) // /.well-known/* and POST /oauth/token
mux.Handle("GET /api/contracts", w.Protect(weldall.Policy{Scopes: []string{"contracts:read"}})(
	http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		auth, _ := weldall.AuthFromContext(r.Context())
		fmt.Fprintf(rw, "hello %s", auth.Subject)
	}),
))
```

`Protect` answers a rejected request with the OAuth error response — for example
`401 {"error":"invalid_token","error_description":"DPoP authorization required"}`
with `WWW-Authenticate: DPoP error="invalid_token"`, or `403 insufficient_scope`
naming the required scopes. To decide inside a handler instead, call
`w.Verify(r, policy)`; every error it returns is an `*weldall.AuthError`, and
`weldall.WriteOAuthError` renders it.

`Verify` accepts both employee tokens (`at+jwt`, issued by this resource's own
token endpoint and verified offline) and machine tokens (`weldall-machine+jwt`,
issued by Weldall). `AuthContext.IdentityType` is `"user"` or `"machine"`.

`RegisterRoutes` claims the origin root, so the service cannot share its host
with another OAuth server.

## Call another service as a machine

```go
token, err := weldall.RequestMachineToken(ctx, weldall.MachineTokenInput{
	Issuer:   "https://weldall.example.com",
	ClientID: "expenses-a",
	Resource: "https://expenses-b.example.com/api",
	Scopes:   []string{"expenses-b:read"},
	Kid:      os.Getenv("MACHINE_SIGNING_KID"),
	Key:      machineKey, // weldall.KeyPair with the registered key
})
if err != nil {
	return err
}
proof, err := weldall.CreateDPoPProof(weldall.DPoPProofInput{
	Key: machineKey, Method: http.MethodGet, URL: target, AccessToken: token.AccessToken,
})
if err != nil {
	return err
}
req, _ := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
req.Header.Set("Authorization", "DPoP "+token.AccessToken)
req.Header.Set("DPoP", proof)
```

Machine tokens live for five minutes. Every request needs a fresh DPoP proof.

## Publish instructions for agents

Configure exactly one of a static `Items` list or a `Load` function:

```go
Skills: &weldall.SkillProvider{Items: []weldall.PublishedSkill{{
	ID:             "list",
	Title:          "List contracts",
	RequiredScopes: []string{"contracts:read"},
	Visibility:     weldall.SkillVisibilityHiddenIfUnallowed,
	Content:        "# List contracts\n\nUse the contracts API.",
}}},
```

Catalogs are strictly validated, limited to 100 skills and 1 MiB, and require
replay protection because Weldall fetches them with one-use signed assertions.
Visibility controls discovery, not authorization: each API route still needs its
own `Protect` policy.

## Use managed signing keys

Instead of a `SigningKey`, a service that keeps its key in a KMS or Vault sets
`SigningProvider` to a `weldall.SigningKeyProvider`. Before returning any token,
the SDK checks that the active key is published, verifies the returned ES256
signature and exact header, and compares the returned claims with the requested
claims.

## Replay protection

`ReplayStore` is required. `InMemory` is process-local and only safe with one
replica; when it is full it fails closed. A horizontally scaled service needs a
shared atomic store — implement `weldall.ReplayStore` over Redis `SET key 1 NX
PXAT <expiresAt>`, returning `true` when the key was set. `weldall.ReplayDisabled`
explicitly accepts replay risk and cannot be combined with skill publication.

## Where the Go API differs

Protocol values, validation order, claims, errors, cache behaviour and replay
behaviour match `@weldall/sdk`. The language-only differences:

- `New` returns a `*weldall.ConfigError` where the TypeScript SDK throws a
  `TypeError`, and validates a direct signing key up front rather than on first
  use. `Verify` folds `verify` and `verifyNoThrow` into one call: every failure
  is an `*AuthError` (non-protocol failures become `401 invalid_token`).
- The empty string means "not set" for optional options such as
  `DiscoveryProxyOrigin`; durations are `time.Duration` (`DiscoveryTimeout`).
- Private keys are a separate `PrivateJWK` type whose private scalar never
  appears in `fmt`, `json.Marshal` or `slog` output; `ExportJSON` is the one
  deliberate way to serialise it.
- URL handling follows the WHATWG URL Standard (Go's `net/url` does not), so
  DPoP `htu` values and resource identifiers normalise exactly as in Node. One
  deliberate deviation: a host made of an empty punycode label (`xn--`) is
  rejected here and accepted by Node.
- Framework adapters are replaced by `net/http` middleware (`Protect`) and
  `RegisterRoutes(*http.ServeMux)`.

## Prepare a production service

- Load a stable ES256 signing key; a new key at startup invalidates issued tokens.
- Keep `Resource`, `PublicOrigin`, the protocol routes and the Weldall
  registration exact.
- Use HTTPS. `AllowInsecureLoopback` is only for local loopback development.
- Use a shared atomic replay store when running more than one replica.
- Call `Ready` at startup so discovery and key problems fail early.

## Development

```sh
pnpm install --frozen-lockfile   # at the repository root, for the interop tests
cd packages/go-sdk
gofmt -l .
go vet ./...
go test -race ./...
```

The interop tests run the official TypeScript SDK through
`testdata/interop.ts`: tokens and DPoP proofs cross between Go and Node in both
directions, URL normalisation is compared with Node's parser, and a harness
drives a Go service over real HTTP with `@weldall/sdk`. They are skipped when the
pnpm workspace is not installed, unless `WELDALL_REQUIRE_INTEROP` is set (CI
sets it).

Releases are tags of the form `packages/go-sdk/vX.Y.Z`, which the Go module
proxy serves directly.

## License

FSL-1.1-ALv2 (Functional Source License), converting to Apache-2.0 two years
after each release. The complete license text is in `LICENSE`.
