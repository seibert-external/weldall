package weldall_test

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"

	weldall "github.com/seibert-external/weldall/packages/go-sdk"
)

// The README's resource example; it compiles but does not run, because it
// needs a reachable Weldall.
func ExampleWeldall_Protect() {
	ctx := context.Background()
	private, public, err := weldall.LoadES256KeyPairFromEnv(
		"WELDALL_SIGNING_PRIVATE_JWK", os.Getenv("WELDALL_SIGNING_PRIVATE_JWK"),
		"WELDALL_SIGNING_PUBLIC_JWK", os.Getenv("WELDALL_SIGNING_PUBLIC_JWK"),
	)
	if err != nil {
		log.Fatal(err)
	}
	replay, err := weldall.InMemory(weldall.InMemoryOptions{})
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
	if err := w.Ready(ctx); err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	w.RegisterRoutes(mux)
	mux.Handle("GET /api/contracts", w.Protect(weldall.Policy{Scopes: []string{"contracts:read"}})(
		http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
			auth, _ := weldall.AuthFromContext(r.Context())
			fmt.Fprintf(rw, "hello %s", auth.Subject)
		}),
	))
	log.Fatal(http.ListenAndServe(":8080", mux))
}

// The README's machine-client example.
func ExampleRequestMachineToken() {
	ctx := context.Background()
	machineKey, err := weldall.GenerateES256KeyPair() // in production: the registered key
	if err != nil {
		log.Fatal(err)
	}
	target := "https://expenses-b.example.com/api/expenses"
	token, err := weldall.RequestMachineToken(ctx, weldall.MachineTokenInput{
		Issuer:   "https://weldall.example.com",
		ClientID: "expenses-a",
		Resource: "https://expenses-b.example.com/api",
		Scopes:   []string{"expenses-b:read"},
		Kid:      os.Getenv("MACHINE_SIGNING_KID"),
		Key:      machineKey,
	})
	if err != nil {
		log.Fatal(err)
	}
	proof, err := weldall.CreateDPoPProof(weldall.DPoPProofInput{
		Key: machineKey, Method: http.MethodGet, URL: target, AccessToken: token.AccessToken,
	})
	if err != nil {
		log.Fatal(err)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	req.Header.Set("Authorization", "DPoP "+token.AccessToken)
	req.Header.Set("DPoP", proof)
	_ = req
}
