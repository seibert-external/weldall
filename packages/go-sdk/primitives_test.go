package weldall

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func expectAuthError(t *testing.T, err error, code string, status int) *AuthError {
	t.Helper()
	authErr, ok := asAuthError(err)
	if !ok {
		t.Fatalf("want AuthError %s/%d, got %v", code, status, err)
	}
	if authErr.Code != code || authErr.Status != status {
		t.Fatalf("want %s/%d, got %s/%d (%s)", code, status, authErr.Code, authErr.Status, authErr.Message)
	}
	return authErr
}

func TestMachineAssertionIsStrictAndCarriesNoPrivateMaterial(t *testing.T) {
	key := mustKeyPair(t)
	assertion, err := CreateMachineClientAssertion(MachineAssertionInput{
		ClientID: "expenses-a", TokenEndpoint: "https://weldall.example/api/auth/oauth2/token",
		Kid: "a1", PrivateJWK: key.Private, JTI: "assertion-1", Now: time.Unix(1000, 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	header, _ := decodeProtectedHeader(assertion)
	payload, _ := decodePayload(assertion)
	if header["alg"] != "ES256" || header["typ"] != "JWT" || header["kid"] != "a1" {
		t.Fatalf("header %v", header)
	}
	want := map[string]any{
		"iss": "expenses-a", "sub": "expenses-a", "aud": "https://weldall.example/api/auth/oauth2/token",
		"iat": json.Number("1000"), "exp": json.Number("1060"), "jti": "assertion-1",
	}
	if fmt.Sprint(payload) != fmt.Sprint(want) {
		t.Fatalf("payload %v, want %v", payload, want)
	}
	raw, _ := json.Marshal(payload)
	if strings.Contains(string(raw), key.Private.D) {
		t.Fatal("assertion leaks the private key")
	}
	for _, bad := range []MachineAssertionInput{
		{ClientID: "bad client", TokenEndpoint: "https://weldall.example/t", Kid: "a1", PrivateJWK: key.Private},
		{ClientID: "a", TokenEndpoint: "https://weldall.example/t", Kid: "bad kid", PrivateJWK: key.Private},
		{ClientID: "a", TokenEndpoint: "https://weldall.example/t?x=1", Kid: "a1", PrivateJWK: key.Private},
	} {
		if _, err := CreateMachineClientAssertion(bad); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}

func TestRequestMachineTokenRejectsErrorsMalformedResponsesAndResourceQueries(t *testing.T) {
	key := mustKeyPair(t)
	respond := func(status int, body string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(body))
		}))
	}
	request := func(issuer, resource string) error {
		_, err := RequestMachineToken(context.Background(), MachineTokenInput{
			Issuer: issuer, ClientID: "expenses-a", Resource: resource,
			Scopes: []string{"expenses:read"}, Kid: "a1", Key: key,
		})
		return err
	}
	oauthError := respond(http.StatusBadRequest, `{"error":"invalid_scope"}`)
	defer oauthError.Close()
	expectAuthError(t, request(oauthError.URL, "https://expenses.example/api"), "invalid_scope", 400)

	malformed := respond(http.StatusOK, `{"access_token":"token","token_type":"Bearer"}`)
	defer malformed.Close()
	expectAuthError(t, request(malformed.URL, "https://expenses.example/api"), "server_error", 500)

	err := request(malformed.URL, "https://expenses.example/api?tenant=one")
	var configErr *ConfigError
	if !errors.As(err, &configErr) ||
		configErr.Message != "resource must be an origin without credentials, path, query, or fragment" {
		t.Fatalf("resource query: %v", err)
	}
}

func TestVerifyStrictDPoPRejections(t *testing.T) {
	device := mustKeyPair(t)
	foreign := mustKeyPair(t)
	now := time.Now()
	url := "https://api.example/items"
	proof := func(in DPoPProofInput) string {
		if in.Key.JKT == "" {
			in.Key = device
		}
		if in.Method == "" {
			in.Method = "GET"
		}
		if in.URL == "" {
			in.URL = url
		}
		if in.Now.IsZero() {
			in.Now = now
		}
		p, err := CreateDPoPProof(in)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	verify := func(p string, in VerifyDPoPInput) error {
		if in.Method == "" {
			in.Method = "GET"
		}
		if in.URL == "" {
			in.URL = url
		}
		if in.Replay == nil {
			in.Replay = ReplayDisabled
		}
		in.Now = now
		_, err := VerifyStrictDPoP(context.Background(), p, in)
		return err
	}
	if err := verify(proof(DPoPProofInput{AccessToken: "token"}), VerifyDPoPInput{AccessToken: "token", ExpectedJKT: device.JKT}); err != nil {
		t.Fatalf("valid proof rejected: %v", err)
	}
	if err := verify(proof(DPoPProofInput{}), VerifyDPoPInput{URL: "https://API.example:443/items?x=1"}); err != nil {
		t.Fatalf("normalised URL rejected: %v", err)
	}
	cases := map[string]error{
		"wrong method":         verify(proof(DPoPProofInput{Method: "POST"}), VerifyDPoPInput{}),
		"wrong URL":            verify(proof(DPoPProofInput{URL: "https://api.example/other"}), VerifyDPoPInput{}),
		"ath mismatch":         verify(proof(DPoPProofInput{AccessToken: "a"}), VerifyDPoPInput{AccessToken: "b"}),
		"ath missing":          verify(proof(DPoPProofInput{}), VerifyDPoPInput{AccessToken: "token"}),
		"ath not allowed":      verify(proof(DPoPProofInput{AccessToken: "token"}), VerifyDPoPInput{}),
		"foreign key":          verify(proof(DPoPProofInput{Key: foreign}), VerifyDPoPInput{ExpectedJKT: device.JKT}),
		"iat too old":          verify(proof(DPoPProofInput{Now: now.Add(-61 * time.Second)}), VerifyDPoPInput{}),
		"iat in the future":    verify(proof(DPoPProofInput{Now: now.Add(6 * time.Second)}), VerifyDPoPInput{}),
		"not a JWS":            verify("not.a.proof", VerifyDPoPInput{}),
		"tampered signature":   verify(proof(DPoPProofInput{})+"A", VerifyDPoPInput{}),
		"access token as DPoP": verify(mustAccessToken(t, device), VerifyDPoPInput{}),
	}
	for name, err := range cases {
		t.Run(name, func(t *testing.T) { expectAuthError(t, err, "invalid_dpop_proof", 400) })
	}

	store, _ := InMemory(InMemoryOptions{SuppressWarning: true})
	once := proof(DPoPProofInput{})
	if err := verify(once, VerifyDPoPInput{Replay: store}); err != nil {
		t.Fatal(err)
	}
	replayed := expectAuthError(t, verify(once, VerifyDPoPInput{Replay: store}), "invalid_dpop_proof", 400)
	if replayed.Reason != ReasonReplayDetected {
		t.Fatalf("replay reason %q", replayed.Reason)
	}
}

func mustAccessToken(t *testing.T, device KeyPair) string {
	t.Helper()
	signing := mustKeyPair(t)
	token, err := IssueAccessToken(IssueTokenInput{
		Issuer: "https://api.example", Subject: "u", Email: "u@example.com", Resource: "https://api.example/api",
		ClientID: "c", Scopes: []string{"a:read"}, JKT: device.JKT, Kid: "k", PrivateJWK: signing.Private,
	})
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestAssertPublicP256IsStrict(t *testing.T) {
	key := mustKeyPair(t)
	decode := func(extra string) JWK {
		var k JWK
		raw := fmt.Sprintf(`{"kty":"EC","crv":"P-256","x":%q,"y":%q%s}`, key.Public.X, key.Public.Y, extra)
		if err := json.Unmarshal([]byte(raw), &k); err != nil {
			t.Fatal(err)
		}
		return k
	}
	for _, extra := range []string{"", `,"kid":"k1","alg":"ES256","use":"sig","key_ops":["verify"]`, `,"d":""`} {
		if err := AssertPublicP256(decode(extra)); err != nil {
			t.Errorf("rejected %q: %v", extra, err)
		}
	}
	for _, extra := range []string{
		fmt.Sprintf(`,"d":%q`, key.Private.D), `,"ext":true`, `,"alg":"RS256"`, `,"alg":null`, `,"use":"enc"`,
		`,"key_ops":["sign"]`, `,"key_ops":["verify","sign"]`, `,"x5c":[]`,
	} {
		if err := AssertPublicP256(decode(extra)); err == nil {
			t.Errorf("accepted %q", extra)
		}
	}
	offCurve := key.Public
	offCurve.Y = key.Public.X
	if err := AssertPublicP256(offCurve); err == nil {
		t.Error("accepted a point off the curve")
	}
}

func TestInMemoryReplayStoreFailsClosedAtCapacity(t *testing.T) {
	store, err := InMemory(InMemoryOptions{MaxEntries: 1, SuppressWarning: true})
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Minute)
	if err := consumeReplay(context.Background(), store, "dpop", "a", expires, newAuthError("x", "", 0)); err != nil {
		t.Fatal(err)
	}
	err = consumeReplay(context.Background(), store, "dpop", "b", expires, newAuthError("x", "", 0))
	expectAuthError(t, err, "temporarily_unavailable", http.StatusServiceUnavailable)
	if _, err := InMemory(InMemoryOptions{MaxEntries: -1}); err == nil {
		t.Fatal("accepted a negative capacity")
	}
}

// TestPrivateKeyMaterialNeverRenders is Success Criterion 6: the private
// scalar appears in none of fmt %v / %+v / %#v, json.Marshal or slog output.
func TestPrivateKeyMaterialNeverRenders(t *testing.T) {
	key := mustKeyPair(t)
	direct := DirectSigningKey{Kid: "k1", Private: key.Private, Public: key.Public}
	for name, value := range map[string]any{"PrivateJWK": key.Private, "KeyPair": key, "DirectSigningKey": direct} {
		var logged bytes.Buffer
		slog.New(slog.NewJSONHandler(&logged, nil)).Info("key", "value", value)
		marshalled, _ := json.Marshal(value)
		outputs := map[string]string{
			"%v":           fmt.Sprintf("%v", value),
			"%+v":          fmt.Sprintf("%+v", value),
			"%#v":          fmt.Sprintf("%#v", value),
			"json.Marshal": string(marshalled),
			"slog":         logged.String(),
		}
		for format, output := range outputs {
			if strings.Contains(output, key.Private.D) {
				t.Errorf("%s rendered with %s leaks d: %s", name, format, output)
			}
		}
	}
	exported, _ := key.Private.ExportJSON()
	if !strings.Contains(string(exported), key.Private.D) {
		t.Fatal("ExportJSON must include d")
	}
}

func TestOAuthErrorResponseShape(t *testing.T) {
	recorder := httptest.NewRecorder()
	WriteOAuthError(recorder, newAuthError("invalid_token", "DPoP authorization required", http.StatusUnauthorized))
	if recorder.Code != 401 ||
		recorder.Body.String() != `{"error":"invalid_token","error_description":"DPoP authorization required"}` ||
		recorder.Header().Get("WWW-Authenticate") != `DPoP error="invalid_token"` ||
		recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("got %d %s %v", recorder.Code, recorder.Body, recorder.Header())
	}
	scoped := newAuthError("insufficient_scope", "required scope is missing", http.StatusForbidden)
	scoped.RequiredScopes = []string{"a:read", "b:read"}
	recorder = httptest.NewRecorder()
	WriteOAuthError(recorder, scoped)
	if recorder.Header().Get("WWW-Authenticate") != `DPoP error="insufficient_scope", scope="a:read b:read"` {
		t.Fatalf("got %v", recorder.Header())
	}
	recorder = httptest.NewRecorder()
	WriteOAuthError(recorder, errors.New("database password is hunter2"))
	if recorder.Code != 500 || strings.Contains(recorder.Body.String(), "hunter2") {
		t.Fatalf("unknown error leaked: %d %s", recorder.Code, recorder.Body)
	}
}
