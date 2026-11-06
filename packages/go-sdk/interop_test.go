package weldall

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// These constants match testdata/interop.ts.
const (
	interopIssuer   = "https://interop.example"
	interopResource = "https://interop.example/api"
	interopClientID = "interop-client"
	interopURL      = "https://INTEROP.example:443/api/a//../items?ignored=yes"
)

func TestNodeArtifactsVerifyInGo(t *testing.T) {
	var artifact struct {
		SigningPublicJWK JWK    `json:"signingPublicJwk"`
		DevicePublicJWK  JWK    `json:"devicePublicJwk"`
		DeviceJKT        string `json:"deviceJkt"`
		AccessToken      string `json:"accessToken"`
		GenericJWT       string `json:"genericJwt"`
		Proof            string `json:"proof"`
	}
	node(t, "generate", nil, &artifact)

	generic, err := VerifyES256(artifact.GenericJWT, VerifyES256Input{
		Kid: "node-signing", PublicJWK: artifact.SigningPublicJWK, Issuer: interopIssuer, Audience: interopResource,
	})
	if err != nil || generic["source"] != "node" {
		t.Fatalf("generic JWT: %v %v", generic, err)
	}
	token, err := VerifyAccessToken(artifact.AccessToken, VerifyAccessTokenInput{
		Issuer: interopIssuer, Resource: interopResource, ClientID: interopClientID,
		Kid: "node-signing", PublicJWK: artifact.SigningPublicJWK, RequiredScopes: []string{"interop:read"},
	})
	if err != nil || token["sub"] != "interop-user" {
		t.Fatalf("access token: %v %v", token, err)
	}
	proof, err := VerifyStrictDPoP(context.Background(), artifact.Proof, VerifyDPoPInput{
		Method: "GET", URL: interopURL, Replay: ReplayDisabled,
		AccessToken: artifact.AccessToken, ExpectedJKT: artifact.DeviceJKT,
	})
	if err != nil || proof.JKT != artifact.DeviceJKT {
		t.Fatalf("DPoP proof: %v %v", proof, err)
	}
	if artifact.DevicePublicJWK.Thumbprint() != artifact.DeviceJKT {
		t.Fatalf("thumbprint mismatch")
	}
}

func TestGoArtifactsVerifyInNode(t *testing.T) {
	signing := mustKeyPair(t)
	device := mustKeyPair(t)
	now := time.Now()
	accessToken, err := IssueAccessToken(IssueTokenInput{
		Issuer: interopIssuer, Subject: "interop-user", Email: "interop@example.com",
		Resource: interopResource, ClientID: interopClientID, Scopes: []string{"interop:read"},
		JKT: device.JKT, Kid: "go-signing", PrivateJWK: signing.Private, Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	generic, err := SignES256(map[string]any{
		"iss": interopIssuer, "aud": interopResource, "iat": now.Unix(), "exp": now.Unix() + 300, "source": "go",
	}, "go-signing", signing.Private, "")
	if err != nil {
		t.Fatal(err)
	}
	proof, err := CreateDPoPProof(DPoPProofInput{
		Key: device, Method: "GET", URL: interopURL, AccessToken: accessToken, Now: now, JTI: "go-proof",
	})
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	node(t, "verify", map[string]any{
		"signingPublicJwk": signing.Public,
		"devicePublicJwk":  device.Public,
		"deviceJkt":        device.JKT,
		"accessToken":      accessToken,
		"genericJwt":       generic,
		"proof":            proof,
	}, &result)
	if result["ok"] != true {
		t.Fatalf("Node rejected Go artifacts: %v", result)
	}
}

func TestMachineTokenRequestVerifiesInNode(t *testing.T) {
	key := mustKeyPair(t)
	const clientID, kid = "seabird-gateway", "machine-key-1"
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/auth/oauth2/token" ||
			r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		want := map[string]string{
			"grant_type":            "client_credentials",
			"client_id":             clientID,
			"client_assertion_type": PrivateKeyJWTType,
			"resource":              "https://cdb.example/api",
			"scope":                 "cdb:read cdb-dev:read",
		}
		for name, value := range want {
			if r.PostForm.Get(name) != value {
				t.Errorf("form %s = %q, want %q", name, r.PostForm.Get(name), value)
			}
		}
		var verdict map[string]any
		node(t, "verify-machine", map[string]any{
			"assertion":     r.PostForm.Get("client_assertion"),
			"proof":         r.Header.Get("DPoP"),
			"tokenEndpoint": server.URL + "/api/auth/oauth2/token",
			"publicJwk":     key.Public,
			"kid":           kid,
			"clientId":      clientID,
		}, &verdict)
		if verdict["ok"] != true || verdict["jkt"] != key.JKT {
			t.Errorf("Node rejected the machine request: %v", verdict)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "issued", "token_type": "DPoP", "expires_in": 300, "scope": "cdb:read cdb-dev:read",
		})
	}))
	defer server.Close()

	token, err := RequestMachineToken(context.Background(), MachineTokenInput{
		Issuer: server.URL, ClientID: clientID, Resource: "https://cdb.example/api",
		Scopes: []string{"cdb:read", "cdb-dev:read"}, Kid: kid, Key: key,
	})
	if err != nil {
		t.Fatal(err)
	}
	if token.TokenType != "DPoP" || token.ExpiresIn != 300 || token.AccessToken != "issued" {
		t.Fatalf("unexpected token: %+v", token)
	}
}

func mustKeyPair(t *testing.T) KeyPair {
	t.Helper()
	pair, err := GenerateES256KeyPair()
	if err != nil {
		t.Fatal(err)
	}
	return pair
}
