package weldall

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestCrossImplementationHarness runs a Go resource on localhost and lets the
// official TypeScript SDK drive it over real HTTP, as Weldall and the CLI
// would: discovery documents, the skill catalog, the ID-JAG token exchange,
// and protected calls. Weldall itself is faked by a local server whose key
// the Node side signs with. Run with -v to print the recorded exchanges.
func TestCrossImplementationHarness(t *testing.T) {
	weldallKey := mustKeyPair(t)
	resourceKey := mustKeyPair(t)
	const weldallKid, resourceKid = "weldall-1", "resource-1"

	fakeWeldall := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		host := "http://" + r.Host
		switch r.URL.Path {
		case "/.well-known/oauth-authorization-server":
			writeJSON(rw, 200, nil, map[string]any{"issuer": host, "jwks_uri": host + "/api/oauth/jwks"})
		case "/api/oauth/jwks":
			writeJSON(rw, 200, nil, map[string]any{"keys": []JWK{weldallKey.Public.withSigningMetadata(weldallKid)}})
		default:
			http.NotFound(rw, r)
		}
	}))
	defer fakeWeldall.Close()

	mux := http.NewServeMux()
	resourceServer := httptest.NewServer(mux)
	defer resourceServer.Close()
	origin := resourceServer.URL
	replay, err := InMemory(InMemoryOptions{SuppressWarning: true})
	if err != nil {
		t.Fatal(err)
	}
	w, err := New(fakeWeldall.URL, Options{
		Resource:              origin + "/api",
		PublicOrigin:          origin,
		ClientID:              "weldall-cli-at-expenses",
		SupportedScopes:       []string{"expenses:read"},
		SigningKey:            &DirectSigningKey{Kid: resourceKid, Private: resourceKey.Private, Public: resourceKey.Public},
		ReplayStore:           replay,
		AllowInsecureLoopback: true,
		Skills: &SkillProvider{Items: []PublishedSkill{{
			ID: "list", Title: "List expenses", RequiredScopes: []string{"expenses:read"},
			Visibility: SkillVisibilityHiddenIfUnallowed, Content: "# List expenses",
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	w.RegisterRoutes(mux)
	echo := http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		auth, _ := AuthFromContext(r.Context())
		writeJSON(rw, 200, nil, auth)
	})
	mux.Handle("GET /api/expenses", w.Protect(Policy{Scopes: []string{"expenses:read"}})(echo))
	mux.Handle("GET /api/admin", w.Protect(Policy{Scopes: []string{"admin"}})(echo))

	var result struct {
		Log []struct {
			Name    string            `json:"name"`
			Method  string            `json:"method"`
			URL     string            `json:"url"`
			Status  int               `json:"status"`
			Headers map[string]string `json:"headers"`
			Body    json.RawMessage   `json:"body"`
		} `json:"log"`
		VerifiedSubject string `json:"verifiedSubject"`
		DeviceJKT       string `json:"deviceJkt"`
	}
	node(t, "harness", map[string]any{
		"host": fakeWeldall.URL, "origin": origin, "resource": origin + "/api",
		"clientId": "weldall-cli-at-expenses", "weldallKid": weldallKid, "weldallPrivateJwk": exportedPrivate(t, weldallKey),
	}, &result)

	entries := map[string]int{}
	for i, entry := range result.Log {
		entries[entry.Name] = i
		t.Logf("%s %s -> %d %v %s", entry.Method, entry.URL, entry.Status, entry.Headers, entry.Body)
	}
	body := func(name string, out any) int {
		t.Helper()
		i, ok := entries[name]
		if !ok {
			t.Fatalf("no %q exchange recorded", name)
		}
		if out != nil {
			if err := json.Unmarshal(result.Log[i].Body, out); err != nil {
				t.Fatalf("%s: %v", name, err)
			}
		}
		return result.Log[i].Status
	}

	// Success Criterion 1: each route serves the right content.
	var as authorizationServerMetadata
	if status := body("/.well-known/oauth-authorization-server", &as); status != 200 ||
		as.Issuer != origin || as.TokenEndpoint != origin+"/oauth/token" || as.JWKSURI != origin+"/.well-known/jwks.json" {
		t.Errorf("authorization-server metadata: %d %+v", status, as)
	}
	for _, name := range []string{"/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api"} {
		var pr protectedResourceMetadata
		if status := body(name, &pr); status != 200 || pr.Resource != origin+"/api" ||
			len(pr.AuthorizationServers) != 1 || pr.AuthorizationServers[0] != origin ||
			pr.WeldallSkillsEndpoint != origin+SkillCatalogPath {
			t.Errorf("%s: %d %+v", name, status, pr)
		}
	}
	var jwks struct{ Keys []JWK }
	if status := body("/.well-known/jwks.json", &jwks); status != 200 || len(jwks.Keys) != 1 ||
		jwks.Keys[0].Kid != resourceKid || jwks.Keys[0].Thumbprint() != resourceKey.JKT {
		t.Errorf("jwks: %d %+v", status, jwks)
	}
	var catalog SkillCatalog
	if status := body("skills", &catalog); status != 200 || len(catalog.Skills) != 1 || catalog.Skills[0].ID != "list" {
		t.Errorf("skills: %d %+v", status, catalog)
	}
	var token tokenResponse
	if status := body("token", &token); status != 200 || token.TokenType != "DPoP" || token.ExpiresIn != 600 ||
		token.Scope != "expenses:read" {
		t.Errorf("token: %d %+v", status, token)
	}
	if result.VerifiedSubject != "harness-user" {
		t.Errorf("Node did not verify the Go-issued access token: %q", result.VerifiedSubject)
	}

	// Protected calls: scope policy, replay, and the unauthenticated shape.
	var auth AuthContext
	if status := body("protected with scope", &auth); status != 200 || auth.IdentityType != "user" ||
		auth.Subject != "harness-user" || auth.Email != "harness@example.com" {
		t.Errorf("protected with scope: %d %+v", status, auth)
	}
	expectOAuth := func(name string, status int, code string) {
		t.Helper()
		var e struct{ Error string }
		if got := body(name, &e); got != status || e.Error != code ||
			result.Log[entries[name]].Headers["www-authenticate"] != `DPoP error="`+code+`"`+scopeSuffix(code) {
			t.Errorf("%s: %d %s %v", name, got, e.Error, result.Log[entries[name]].Headers)
		}
	}
	expectOAuth("protected missing scope", 403, "insufficient_scope")
	expectOAuth("replayed proof", 401, "invalid_dpop_proof")

	// Success Criterion 3: the 401 shape, byte for byte.
	unauthenticated := result.Log[entries["no authorization"]]
	if unauthenticated.Status != 401 ||
		string(unauthenticated.Body) != `{"error":"invalid_token","error_description":"DPoP authorization required"}` ||
		unauthenticated.Headers["www-authenticate"] != `DPoP error="invalid_token"` ||
		unauthenticated.Headers["cache-control"] != "no-store" {
		t.Errorf("no authorization: %d %s %v", unauthenticated.Status, unauthenticated.Body, unauthenticated.Headers)
	}
}

func scopeSuffix(code string) string {
	if code == "insufficient_scope" {
		return `, scope="admin"`
	}
	return ""
}

func exportedPrivate(t *testing.T, key KeyPair) json.RawMessage {
	t.Helper()
	exported, err := key.Private.ExportJSON()
	if err != nil {
		t.Fatal(err)
	}
	return json.RawMessage(strings.TrimSpace(string(exported)))
}
