package weldall

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// Ports of packages/sdk/test/core.test.ts and machine.test.ts.

const (
	testHost       = "https://weldall.example"
	testProxy      = "https://weldall-discovery-proxy.example"
	testJWKSURL    = testHost + "/api/oauth/jwks"
	testOrigin     = "https://expenses.example"
	testResource   = testOrigin + "/api"
	testClientID   = "weldall-cli-at-expenses"
	machineOrigin  = "https://expenses-b.example"
	machineResourc = machineOrigin + "/api"
)

// fakeWeldall answers discovery requests like the stubbed fetch in the
// TypeScript tests, and records every URL fetched.
type fakeWeldall struct {
	mu       sync.Mutex
	key      KeyPair
	kid      string
	calls    []string
	metadata map[string]any // overrides the metadata document when set
}

func (f *fakeWeldall) RoundTrip(r *http.Request) (*http.Response, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	target := r.URL.String()
	f.calls = append(f.calls, target)
	reply := func(value any) (*http.Response, error) {
		body, _ := json.Marshal(value)
		return &http.Response{
			StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}},
			Body: io.NopCloser(bytes.NewReader(body)), Request: r,
		}, nil
	}
	switch target {
	case testHost + "/.well-known/oauth-authorization-server", testProxy + "/.well-known/oauth-authorization-server":
		if f.metadata != nil {
			return reply(f.metadata)
		}
		return reply(map[string]any{"issuer": testHost, "jwks_uri": testJWKSURL})
	case testJWKSURL, testProxy + "/api/oauth/jwks":
		return reply(map[string]any{"keys": []any{f.key.Public.withSigningMetadata(f.kid)}})
	}
	return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
}

func (f *fakeWeldall) count(target string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, call := range f.calls {
		if call == target {
			n++
		}
	}
	return n
}

func (f *fakeWeldall) rotate(key KeyPair, kid string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.key, f.kid = key, kid
}

type coreFixture struct {
	weldall                         *fakeWeldall
	weldallKey, localKey, deviceKey KeyPair
}

func newCoreFixture(t *testing.T) *coreFixture {
	weldallKey := mustKeyPair(t)
	return &coreFixture{
		weldall:    &fakeWeldall{key: weldallKey, kid: "w1"},
		weldallKey: weldallKey,
		localKey:   mustKeyPair(t),
		deviceKey:  mustKeyPair(t),
	}
}

func (f *coreFixture) options(t *testing.T) Options {
	replay, err := InMemory(InMemoryOptions{SuppressWarning: true})
	if err != nil {
		t.Fatal(err)
	}
	return Options{
		Resource:        testResource,
		PublicOrigin:    testOrigin,
		ClientID:        testClientID,
		SupportedScopes: []string{"read", "write", "admin"},
		SigningKey:      &DirectSigningKey{Kid: "local", Private: f.localKey.Private, Public: f.localKey.Public},
		ReplayStore:     replay,
		HTTPClient:      &http.Client{Transport: f.weldall},
	}
}

func (f *coreFixture) sdk(t *testing.T, edit ...func(*Options)) *Weldall {
	t.Helper()
	options := f.options(t)
	for _, e := range edit {
		e(&options)
	}
	w, err := New(testHost, options)
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func (f *coreFixture) assertion(t *testing.T, key KeyPair, kid string, scopes ...string) string {
	t.Helper()
	if len(scopes) == 0 {
		scopes = []string{"read", "write"}
	}
	jag, err := IssueIDJAG(IssueTokenInput{
		Issuer: testHost, Subject: "user-1", Email: "user@example.com", Audience: testOrigin,
		ClientID: testClientID, Resource: testResource, Scopes: scopes, JKT: f.deviceKey.JKT,
		Kid: kid, PrivateJWK: key.Private,
	})
	if err != nil {
		t.Fatal(err)
	}
	return jag
}

type exchangeResult struct {
	status int
	body   map[string]any
	header http.Header
}

func (f *coreFixture) exchange(t *testing.T, w *Weldall, jag string) exchangeResult {
	t.Helper()
	proof, err := CreateDPoPProof(DPoPProofInput{Key: f.deviceKey, Method: "POST", URL: testOrigin + "/oauth/token"})
	if err != nil {
		t.Fatal(err)
	}
	form := url.Values{"grant_type": {JWTDPoPGrant}, "assertion": {jag}}
	request := httptest.NewRequest("POST", testOrigin+"/oauth/token", strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("DPoP", proof)
	recorder := httptest.NewRecorder()
	w.TokenHandler().ServeHTTP(recorder, request)
	var body map[string]any
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	return exchangeResult{status: recorder.Code, body: body, header: recorder.Header()}
}

func protectedRequest(t *testing.T, key KeyPair, token, target, method string) *http.Request {
	t.Helper()
	proof, err := CreateDPoPProof(DPoPProofInput{Key: key, Method: method, URL: target, AccessToken: token})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, target, nil)
	request.Header.Set("Authorization", "DPoP "+token)
	request.Header.Set("DPoP", proof)
	return request
}

func TestNewFailsInvalidConfiguration(t *testing.T) {
	f := newCoreFixture(t)
	cases := map[string]struct {
		host string
		edit func(*Options)
		want string
	}{
		"remote http host":        {"http://remote.example", nil, "HTTPS"},
		"public origin with path": {testHost, func(o *Options) { o.PublicOrigin = testOrigin + "/path" }, "origin"},
		"mismatched signing key": {testHost, func(o *Options) {
			o.SigningKey = &DirectSigningKey{Kid: "bad", Private: f.localKey.Private, Public: f.weldallKey.Public}
		}, "signing key"},
		"discovery timeout":      {testHost, func(o *Options) { o.DiscoveryTimeout = time.Millisecond }, "discoveryTimeout"},
		"http proxy":             {testHost, func(o *Options) { o.DiscoveryProxyOrigin = "http://proxy.example" }, "HTTPS"},
		"proxy with path":        {testHost, func(o *Options) { o.DiscoveryProxyOrigin = testProxy + "/path" }, "origin"},
		"no signing key":         {testHost, func(o *Options) { o.SigningKey = nil }, "signingKey is required"},
		"no replay store":        {testHost, func(o *Options) { o.ReplayStore = nil }, "replayStore is required"},
		"resource with query":    {testHost, func(o *Options) { o.Resource = testResource + "?x=1" }, "query"},
		"blank client id":        {testHost, func(o *Options) { o.ClientID = "  " }, "clientId"},
		"duplicate scopes":       {testHost, func(o *Options) { o.SupportedScopes = []string{"read", "read"} }, "supportedScopes"},
		"skills without replay":  {testHost, func(o *Options) { o.ReplayStore = ReplayDisabled; o.Skills = &SkillProvider{Items: []PublishedSkill{}} }, "replay"},
		"skills with both modes": {testHost, func(o *Options) { o.Skills = &SkillProvider{} }, "exactly one"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			options := f.options(t)
			if c.edit != nil {
				c.edit(&options)
			}
			_, err := New(c.host, options)
			var configErr *ConfigError
			if !errors.As(err, &configErr) || !strings.Contains(configErr.Message, c.want) {
				t.Fatalf("want config error containing %q, got %v", c.want, err)
			}
		})
	}
	if _, err := New(testHost, f.options(t)); err != nil {
		t.Fatal(err)
	}
}

func TestReadyPreloadsAndPublishesMetadata(t *testing.T) {
	f := newCoreFixture(t)
	w := f.sdk(t)
	if len(f.weldall.calls) != 0 {
		t.Fatalf("New fetched %v", f.weldall.calls)
	}
	if err := w.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{testHost + "/.well-known/oauth-authorization-server", testJWKSURL}
	if strings.Join(f.weldall.calls, ",") != strings.Join(want, ",") {
		t.Fatalf("calls %v", f.weldall.calls)
	}
	var asMetadata map[string]any
	serve(t, w.AuthorizationServerMetadataHandler(), "GET", "/.well-known/oauth-authorization-server", &asMetadata)
	if asMetadata["issuer"] != testOrigin || asMetadata["token_endpoint"] != testOrigin+"/oauth/token" ||
		len(asMetadata["response_types_supported"].([]any)) != 0 {
		t.Fatalf("metadata %v", asMetadata)
	}
	var jwks struct{ Keys []JWK }
	serve(t, w.JWKSHandler(), "GET", "/.well-known/jwks.json", &jwks)
	if len(jwks.Keys) != 1 || jwks.Keys[0].Kid != "local" || jwks.Keys[0].Thumbprint() != f.localKey.JKT {
		t.Fatalf("jwks %+v", jwks)
	}
}

func serve(t *testing.T, h http.Handler, method, target string, out any) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	h.ServeHTTP(recorder, httptest.NewRequest(method, testOrigin+target, nil))
	if out != nil {
		if err := json.Unmarshal(recorder.Body.Bytes(), out); err != nil {
			t.Fatalf("%s %s: %v %s", method, target, err, recorder.Body)
		}
	}
	return recorder
}

func TestDiscoveryProxy(t *testing.T) {
	f := newCoreFixture(t)
	w := f.sdk(t, func(o *Options) { o.DiscoveryProxyOrigin = testProxy })
	if err := w.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := testProxy + "/.well-known/oauth-authorization-server," + testProxy + "/api/oauth/jwks"
	if strings.Join(f.weldall.calls, ",") != want {
		t.Fatalf("calls %v", f.weldall.calls)
	}
	if r := f.exchange(t, w, f.assertion(t, f.weldallKey, "w1")); r.status != 200 {
		t.Fatalf("exchange %d %v", r.status, r.body)
	}
	f.weldall.metadata = map[string]any{"issuer": testProxy, "jwks_uri": testProxy + "/api/oauth/jwks"}
	expectAuthError(t, f.sdk(t, func(o *Options) { o.DiscoveryProxyOrigin = testProxy }).Ready(context.Background()),
		"temporarily_unavailable", 503)
}

func TestRejectsUnsafeDiscoveryMetadata(t *testing.T) {
	for _, metadata := range []map[string]any{
		{"issuer": "https://evil.example", "jwks_uri": testHost + "/jwks"},
		{"issuer": testHost, "jwks_uri": "https://evil.example/jwks"},
		{"issuer": testHost, "jwks_uri": testHost + "/jwks?redirect=evil"},
	} {
		f := newCoreFixture(t)
		f.weldall.metadata = metadata
		expectAuthError(t, f.sdk(t).Ready(context.Background()), "temporarily_unavailable", 503)
	}
}

func TestSkillCatalogPublication(t *testing.T) {
	f := newCoreFixture(t)
	w := f.sdk(t, func(o *Options) {
		o.SupportedScopes = []string{"expenses:read"}
		o.Skills = &SkillProvider{Items: []PublishedSkill{{
			ID: "review", Title: "Review expenses", RequiredScopes: []string{"expenses:read"},
			Visibility: SkillVisibilityDefault, Content: "# Review expenses",
			Meta: &SkillMeta{
				Tags: []string{"finance", "review"}, Owner: "user-123",
				Appearance: map[string]string{"icon": "file-text", "gradientFrom": "invalid-but-safe"},
			},
			LastUpdatedAt: "not restricted to a timestamp",
		}}}
	})
	var metadata map[string]any
	serve(t, w.ProtectedResourceMetadataHandler(), "GET", "/.well-known/oauth-protected-resource", &metadata)
	if metadata["weldall_skills_endpoint"] != testOrigin+SkillCatalogPath {
		t.Fatalf("metadata %v", metadata)
	}
	now := time.Now().Unix()
	token, err := SignES256(map[string]any{
		"iss": testHost, "sub": testHost, "aud": testOrigin + SkillCatalogPath, "resource": testResource,
		"purpose": "skills:read", "iat": now, "exp": now + 60, "jti": "skills-test",
	}, "w1", f.weldallKey.Private, SkillAssertionType)
	if err != nil {
		t.Fatal(err)
	}
	request := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", testOrigin+SkillCatalogPath, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		recorder := httptest.NewRecorder()
		w.SkillsHandler().ServeHTTP(recorder, r)
		return recorder
	}
	first := request()
	var catalog SkillCatalog
	if err := json.Unmarshal(first.Body.Bytes(), &catalog); err != nil || first.Code != 200 {
		t.Fatalf("skills %d %s", first.Code, first.Body)
	}
	if first.Header().Get("Cache-Control") != "private, no-store" || catalog.SchemaVersion != 1 ||
		catalog.Resource != testResource || len(catalog.Skills) != 1 || catalog.Skills[0].ID != "review" ||
		catalog.Skills[0].Meta.Owner != "user-123" || catalog.Skills[0].LastUpdatedAt != "not restricted to a timestamp" {
		t.Fatalf("catalog %+v", catalog)
	}
	if replay := request(); replay.Code != 401 {
		t.Fatalf("replayed assertion: %d", replay.Code)
	}
	if code := serve(t, f.sdk(t).SkillsHandler(), "GET", SkillCatalogPath, nil).Code; code != 404 {
		t.Fatalf("unconfigured skills: %d", code)
	}
}

func TestRejectsInvalidSkillTags(t *testing.T) {
	for _, tags := range [][]any{{""}, {strings.Repeat("x", 41)}, make([]any, 21)} {
		for i := range tags {
			if tags[i] == nil {
				tags[i] = "tag"
			}
		}
		_, err := ParseSkillCatalog(map[string]any{
			"schemaVersion": json.Number("1"), "resource": testResource,
			"skills": []any{map[string]any{
				"id": "review", "title": "Review expenses", "requiredScopes": []any{},
				"visibility": "DEFAULT", "content": "# Review expenses", "meta": map[string]any{"tags": tags},
			}},
		}, "")
		if err == nil || !strings.Contains(err.Error(), "meta") {
			t.Errorf("tags %v: %v", tags, err)
		}
	}
}

func TestExchangeAndOfflineVerification(t *testing.T) {
	f := newCoreFixture(t)
	w := f.sdk(t)
	r := f.exchange(t, w, f.assertion(t, f.weldallKey, "w1"))
	if r.status != 200 || r.body["token_type"] != "DPoP" || r.body["expires_in"] != float64(600) ||
		r.header.Get("Cache-Control") != "no-store" {
		t.Fatalf("exchange %d %v", r.status, r.body)
	}
	token := r.body["access_token"].(string)
	claims, _ := decodePayload(token)
	if claims["iss"] != testOrigin || claims["aud"] != testResource || claims["sub"] != "user-1" ||
		claims["email"] != "user@example.com" || claims["scope"] != "read write" || cnfJKT(claims) != f.deviceKey.JKT {
		t.Fatalf("claims %v", claims)
	}
	f.weldall.mu.Lock()
	before := len(f.weldall.calls)
	f.weldall.mu.Unlock()
	auth, err := w.Verify(protectedRequest(t, f.deviceKey, token, testOrigin+"/api/expenses", "GET"),
		Policy{Scopes: []string{"read"}, AnyScopes: []string{"write", "admin"}})
	if err != nil {
		t.Fatal(err)
	}
	if auth.IdentityType != "user" || auth.Subject != "user-1" || auth.Email != "user@example.com" ||
		!auth.EmailVerified || auth.Identity.Type != "user" || strings.Join(auth.Scopes, " ") != "read write" ||
		auth.ClientID != testClientID {
		t.Fatalf("auth %+v", auth)
	}
	if len(f.weldall.calls) != before {
		t.Fatal("verifying a user token used the network")
	}
}

func TestRejectsLocalTokensWithWrongIssuerAudienceOrEmail(t *testing.T) {
	f := newCoreFixture(t)
	w := f.sdk(t)
	issue := func(issuer, resource string) string {
		token, err := IssueAccessToken(IssueTokenInput{
			Issuer: issuer, Subject: "user-1", Email: "user@example.com", Resource: resource, ClientID: testClientID,
			Scopes: []string{"read"}, JKT: f.deviceKey.JKT, Kid: "local", PrivateJWK: f.localKey.Private,
		})
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	valid, _ := decodePayload(issue(testOrigin, testResource))
	patched := func(patch map[string]any) string {
		claims := map[string]any{}
		for k, v := range valid {
			claims[k] = v
		}
		for k, v := range patch {
			if v == nil {
				delete(claims, k)
			} else {
				claims[k] = v
			}
		}
		token, err := SignES256(claims, "local", f.localKey.Private, "at+jwt")
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	for name, token := range map[string]string{
		"wrong issuer":     issue("https://wrong.example", testResource),
		"wrong audience":   issue(testOrigin, "https://wrong.example/api"),
		"missing email":    patched(map[string]any{"email": nil}),
		"invalid email":    patched(map[string]any{"email": "not-an-email"}),
		"unverified email": patched(map[string]any{"email_verified": false}),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := w.Verify(protectedRequest(t, f.deviceKey, token, testOrigin+"/api/expenses", "GET"), Policy{})
			expectAuthError(t, err, "invalid_token", 401)
			_, err = VerifyAccessToken(token, VerifyAccessTokenInput{
				Issuer: testOrigin, Resource: testResource, ClientID: testClientID, Kid: "local", PublicJWK: f.localKey.Public,
			})
			expectAuthError(t, err, "invalid_token", 401)
		})
	}
}

func TestConsistent401And403AndProofReplay(t *testing.T) {
	f := newCoreFixture(t)
	w := f.sdk(t)
	token := f.exchange(t, w, f.assertion(t, f.weldallKey, "w1")).body["access_token"].(string)
	target := testOrigin + "/api/expenses"
	_, err := w.Verify(protectedRequest(t, f.deviceKey, token, target, "GET"), Policy{Scopes: []string{"admin"}})
	scoped := expectAuthError(t, err, "insufficient_scope", 403)
	if strings.Join(scoped.RequiredScopes, " ") != "admin" {
		t.Fatalf("required scopes %v", scoped.RequiredScopes)
	}
	malformed := httptest.NewRequest("GET", target, nil)
	malformed.Header.Set("Authorization", "DPoP "+token)
	malformed.Header.Set("DPoP", "not-a-proof")
	_, err = w.Verify(malformed, Policy{Scopes: []string{"admin"}})
	expectAuthError(t, err, "invalid_dpop_proof", 401)

	first := protectedRequest(t, f.deviceKey, token, target, "GET")
	if _, err := w.Verify(first, Policy{}); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	w.Protect(Policy{})(http.NotFoundHandler()).ServeHTTP(recorder, first)
	if recorder.Code != 401 || !strings.Contains(recorder.Header().Get("WWW-Authenticate"), "invalid_dpop_proof") {
		t.Fatalf("replay: %d %v", recorder.Code, recorder.Header())
	}
	_, err = w.Verify(first, Policy{})
	if authErr := expectAuthError(t, err, "invalid_dpop_proof", 401); authErr.Reason != ReasonReplayDetected {
		t.Fatalf("reason %q", authErr.Reason)
	}
}

func TestNetworkPathRequestCannotEscapePublicOrigin(t *testing.T) {
	f := newCoreFixture(t)
	w := f.sdk(t)
	token := f.exchange(t, w, f.assertion(t, f.weldallKey, "w1")).body["access_token"].(string)
	proof, err := CreateDPoPProof(DPoPProofInput{Key: f.deviceKey, Method: "GET", URL: "https://evil.example/path", AccessToken: token})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", testOrigin+"//evil.example/path", nil)
	request.Header.Set("Authorization", "DPoP "+token)
	request.Header.Set("DPoP", proof)
	_, err = w.Verify(request, Policy{})
	expectAuthError(t, err, "invalid_dpop_proof", 401)
}

func TestExchangePinsIDJAGClaims(t *testing.T) {
	f := newCoreFixture(t)
	issue := func(edit func(*IssueTokenInput)) string {
		in := IssueTokenInput{
			Issuer: testHost, Subject: "user-1", Email: "user@example.com", Audience: testOrigin, ClientID: testClientID,
			Resource: testResource, Scopes: []string{"read"}, JKT: f.deviceKey.JKT, Kid: "w1", PrivateJWK: f.weldallKey.Private,
		}
		edit(&in)
		jag, err := IssueIDJAG(in)
		if err != nil {
			t.Fatal(err)
		}
		return jag
	}
	for name, jag := range map[string]string{
		"audience":  issue(func(in *IssueTokenInput) { in.Audience = "https://wrong.example" }),
		"client":    issue(func(in *IssueTokenInput) { in.ClientID = "wrong" }),
		"resource":  issue(func(in *IssueTokenInput) { in.Resource = "https://wrong.example/api" }),
		"scope":     issue(func(in *IssueTokenInput) { in.Scopes = []string{"unknown"} }),
		"device":    issue(func(in *IssueTokenInput) { in.JKT = mustKeyPair(t).JKT }),
		"weldall":   issue(func(in *IssueTokenInput) { in.PrivateJWK = f.localKey.Private }),
		"issuer":    issue(func(in *IssueTokenInput) { in.Issuer = testProxy }),
		"malformed": "not.a.jwt",
	} {
		t.Run(name, func(t *testing.T) {
			if r := f.exchange(t, f.sdk(t), jag); r.status != 400 {
				t.Fatalf("status %d %v", r.status, r.body)
			}
		})
	}
	valid, _ := decodePayload(f.assertion(t, f.weldallKey, "w1"))
	for name, patch := range map[string]map[string]any{
		"missing email": {"email": nil}, "invalid email": {"email": "not-an-email"}, "unverified email": {"email_verified": false},
	} {
		claims := map[string]any{}
		for k, v := range valid {
			claims[k] = v
		}
		for k, v := range patch {
			if v == nil {
				delete(claims, k)
			} else {
				claims[k] = v
			}
		}
		jag, _ := SignES256(claims, "w1", f.weldallKey.Private, "oauth-id-jag+jwt")
		_, err := VerifyIDJAG(jag, VerifyIDJAGInput{
			Issuer: testHost, Audience: testOrigin, Resource: testResource, ClientID: testClientID,
			Kid: "w1", PublicJWK: f.weldallKey.Public, AllowedScopes: []string{"read", "write"},
		})
		expectAuthError(t, err, "invalid_grant", 400)
		if r := f.exchange(t, f.sdk(t), jag); r.status != 400 {
			t.Errorf("%s: status %d", name, r.status)
		}
	}
}

func TestExchangeConsumesIDJAGAtomicallyAndEnforcesStrictForms(t *testing.T) {
	f := newCoreFixture(t)
	w := f.sdk(t)
	jag := f.assertion(t, f.weldallKey, "w1")
	statuses := make(chan int, 2)
	for range 2 {
		go func() { statuses <- f.exchange(t, w, jag).status }()
	}
	a, b := <-statuses, <-statuses
	if a+b != 600 || a == b {
		t.Fatalf("statuses %d %d, want one 200 and one 400", a, b)
	}
	post := func(contentType, body string, proof bool) int {
		r := httptest.NewRequest("POST", testOrigin+"/oauth/token", strings.NewReader(body))
		r.Header.Set("Content-Type", contentType)
		if proof {
			p, _ := CreateDPoPProof(DPoPProofInput{Key: f.deviceKey, Method: "POST", URL: testOrigin + "/oauth/token"})
			r.Header.Set("DPoP", p)
		}
		recorder := httptest.NewRecorder()
		w.TokenHandler().ServeHTTP(recorder, r)
		return recorder.Code
	}
	valid := url.Values{"grant_type": {JWTDPoPGrant}, "assertion": {f.assertion(t, f.weldallKey, "w1")}}.Encode()
	if code := serve(t, w.TokenHandler(), "GET", "/oauth/token", nil).Code; code != 400 {
		t.Fatalf("GET token: %d", code)
	}
	for name, code := range map[string]int{
		"json body":       post("application/json", valid, true),
		"duplicate grant": post("application/x-www-form-urlencoded", valid+"&grant_type="+url.QueryEscape(JWTDPoPGrant), true),
		"extra parameter": post("application/x-www-form-urlencoded", valid+"&scope=read", true),
		"too large":       post("application/x-www-form-urlencoded", valid+"&x="+strings.Repeat("a", 64_000), true),
		"no proof":        post("application/x-www-form-urlencoded", valid, false),
		"wrong grant":     post("application/x-www-form-urlencoded", "grant_type=password&assertion=x", true),
	} {
		if code != 400 {
			t.Errorf("%s: %d", name, code)
		}
	}
}

func TestJWKSRotation(t *testing.T) {
	t.Run("unknown rotated kid refreshes once", func(t *testing.T) {
		f := newCoreFixture(t)
		w := f.sdk(t)
		_ = w.Ready(context.Background())
		rotated := mustKeyPair(t)
		f.weldall.rotate(rotated, "w2")
		if r := f.exchange(t, w, f.assertion(t, rotated, "w2", "read")); r.status != 200 {
			t.Fatalf("status %d %v", r.status, r.body)
		}
		if n := f.weldall.count(testJWKSURL); n != 2 {
			t.Fatalf("JWKS fetched %d times", n)
		}
	})
	t.Run("rotated key reusing the kid refreshes", func(t *testing.T) {
		f := newCoreFixture(t)
		w := f.sdk(t)
		_ = w.Ready(context.Background())
		rotated := mustKeyPair(t)
		f.weldall.rotate(rotated, "w1")
		if r := f.exchange(t, w, f.assertion(t, rotated, "w1", "read")); r.status != 200 {
			t.Fatalf("status %d %v", r.status, r.body)
		}
		if n := f.weldall.count(testJWKSURL); n != 2 {
			t.Fatalf("JWKS fetched %d times", n)
		}
	})
	t.Run("concurrent exchanges share one refresh", func(t *testing.T) {
		f := newCoreFixture(t)
		w := f.sdk(t)
		_ = w.Ready(context.Background())
		rotated := mustKeyPair(t)
		f.weldall.rotate(rotated, "w1")
		statuses := make(chan int, 2)
		for range 2 {
			jag := f.assertion(t, rotated, "w1", "read")
			go func() { statuses <- f.exchange(t, w, jag).status }()
		}
		if a, b := <-statuses, <-statuses; a != 200 || b != 200 {
			t.Fatalf("statuses %d %d", a, b)
		}
		if n := f.weldall.count(testJWKSURL); n != 2 {
			t.Fatalf("JWKS fetched %d times", n)
		}
	})
	t.Run("removed key is no longer trusted after the cache expires", func(t *testing.T) {
		f := newCoreFixture(t)
		offset := time.Duration(0)
		var mu sync.Mutex
		w := f.sdk(t, func(o *Options) {
			o.Now = func() time.Time { mu.Lock(); defer mu.Unlock(); return time.Now().Add(offset) }
		})
		_ = w.Ready(context.Background())
		removed := f.weldallKey
		f.weldall.rotate(mustKeyPair(t), "w2")
		mu.Lock()
		offset = 61 * time.Second
		mu.Unlock()
		r := f.exchange(t, w, f.assertion(t, removed, "w1", "read"))
		if r.status != 400 || r.body["error"] != "invalid_grant" {
			t.Fatalf("status %d %v", r.status, r.body)
		}
		if n := f.weldall.count(testJWKSURL); n < 2 {
			t.Fatalf("JWKS fetched %d times", n)
		}
	})
}

type failingReplayStore struct{}

func (failingReplayStore) Consume(context.Context, string, time.Time) (bool, error) {
	return false, errors.New("redis unavailable")
}

func TestExchangeFailsClosedWhenReplayStorageFails(t *testing.T) {
	f := newCoreFixture(t)
	w := f.sdk(t, func(o *Options) { o.ReplayStore = failingReplayStore{} })
	r := f.exchange(t, w, f.assertion(t, f.weldallKey, "w1", "read"))
	if r.status != 503 || r.body["error"] != "temporarily_unavailable" {
		t.Fatalf("status %d %v", r.status, r.body)
	}
}

// kmsProvider is a SigningKeyProvider whose Sign may misbehave.
type kmsProvider struct {
	key  KeyPair
	sign func(ctx context.Context, payload map[string]any, header SigningHeader) (string, error)
}

func (p kmsProvider) Current(context.Context) (ProviderSigningKey, error) {
	return ProviderSigningKey{Kid: "kms", PublicJWK: p.key.Public, Sign: p.sign}, nil
}

func (p kmsProvider) JWKS(context.Context) ([]JWK, error) {
	public := p.key.Public
	public.Kid = "kms"
	return []JWK{public}, nil
}

func TestSigningProviderOutputIsVerified(t *testing.T) {
	f := newCoreFixture(t)
	honest := func(_ context.Context, payload map[string]any, header SigningHeader) (string, error) {
		return SignES256(payload, header.Kid, f.localKey.Private, header.Typ)
	}
	providerSDK := func(sign func(context.Context, map[string]any, SigningHeader) (string, error)) *Weldall {
		return f.sdk(t, func(o *Options) {
			o.SigningKey = nil
			o.SigningProvider = kmsProvider{key: f.localKey, sign: sign}
		})
	}
	if r := f.exchange(t, providerSDK(honest), f.assertion(t, f.weldallKey, "w1", "read")); r.status != 200 {
		t.Fatalf("honest provider: %d %v", r.status, r.body)
	}
	for name, sign := range map[string]func(context.Context, map[string]any, SigningHeader) (string, error){
		"not a JWT": func(context.Context, map[string]any, SigningHeader) (string, error) { return "not-a-jwt", nil },
		"mutates payload": func(ctx context.Context, payload map[string]any, header SigningHeader) (string, error) {
			payload["scope"] = "admin"
			return honest(ctx, payload, header)
		},
		"fails": func(context.Context, map[string]any, SigningHeader) (string, error) {
			return "", errors.New("kms down")
		},
	} {
		t.Run(name, func(t *testing.T) {
			r := f.exchange(t, providerSDK(sign), f.assertion(t, f.weldallKey, "w1", "read"))
			if r.status != 500 || r.body["error"] != "server_error" {
				t.Fatalf("status %d %v", r.status, r.body)
			}
		})
	}
}

// --- machine.test.ts ---

type machineFixture struct {
	weldall                          *fakeWeldall
	weldallKey, resourceKey, machine KeyPair
}

func newMachineFixture(t *testing.T) *machineFixture {
	weldallKey := mustKeyPair(t)
	return &machineFixture{
		weldall:    &fakeWeldall{key: weldallKey, kid: "w1"},
		weldallKey: weldallKey, resourceKey: mustKeyPair(t), machine: mustKeyPair(t),
	}
}

func (m *machineFixture) verifier(t *testing.T, replay ReplayStore) *Weldall {
	t.Helper()
	if replay == nil {
		replay, _ = InMemory(InMemoryOptions{SuppressWarning: true})
	}
	w, err := New(testHost, Options{
		Resource: machineResourc, PublicOrigin: machineOrigin, ClientID: "expenses-b",
		SupportedScopes: []string{"expenses:read", "expenses:create"},
		SigningKey:      &DirectSigningKey{Kid: "resource-1", Private: m.resourceKey.Private, Public: m.resourceKey.Public},
		ReplayStore:     replay,
		HTTPClient:      &http.Client{Transport: m.weldall},
	})
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func (m *machineFixture) token(t *testing.T, patch map[string]any, typ string) string {
	t.Helper()
	if typ == "" {
		typ = MachineTokenTyp
	}
	now := time.Now().Unix()
	claims := map[string]any{
		"iss": testHost, "sub": "machine:expenses-a", "client_id": "expenses-a", "azp": "expenses-a",
		"aud": machineResourc, "scope": "expenses:read", "identity_type": "machine", "token_type": "machine",
		"cnf": map[string]any{"jkt": m.machine.JKT}, "iat": now, "exp": now + 300, "jti": "token-" + newJTI(),
	}
	for k, v := range patch {
		claims[k] = v
	}
	token, err := SignES256(claims, "w1", m.weldallKey.Private, typ)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func (m *machineFixture) request(t *testing.T, token string, key KeyPair) *http.Request {
	return protectedRequest(t, key, token, machineResourc+"/expenses", "GET")
}

func TestMachinePrincipalAndProofReplay(t *testing.T) {
	m := newMachineFixture(t)
	w := m.verifier(t, nil)
	token := m.token(t, nil, "")
	first := m.request(t, token, m.machine)
	auth, err := w.Verify(first, Policy{Scopes: []string{"expenses:read"}})
	if err != nil {
		t.Fatal(err)
	}
	if auth.IdentityType != "machine" || auth.ClientID != "expenses-a" ||
		auth.Identity != (Principal{Type: "machine", Subject: "machine:expenses-a", ClientID: "expenses-a"}) {
		t.Fatalf("auth %+v", auth)
	}
	_, err = w.Verify(first, Policy{})
	if authErr := expectAuthError(t, err, "invalid_dpop_proof", 401); authErr.Reason != ReasonReplayDetected {
		t.Fatalf("reason %q", authErr.Reason)
	}
	_, err = w.Verify(m.request(t, token, m.machine), Policy{Scopes: []string{"expenses:create"}})
	expectAuthError(t, err, "insufficient_scope", 403)
}

func TestMachineReplayDisabledAndCapacity(t *testing.T) {
	m := newMachineFixture(t)
	disabled := m.verifier(t, ReplayDisabled)
	repeated := m.request(t, m.token(t, nil, ""), m.machine)
	for range 2 {
		if _, err := disabled.Verify(repeated, Policy{}); err != nil {
			t.Fatal(err)
		}
	}
	bounded, _ := InMemory(InMemoryOptions{MaxEntries: 1, SuppressWarning: true})
	w := m.verifier(t, bounded)
	if _, err := w.Verify(m.request(t, m.token(t, nil, ""), m.machine), Policy{}); err != nil {
		t.Fatal(err)
	}
	_, err := w.Verify(m.request(t, m.token(t, nil, ""), m.machine), Policy{})
	expectAuthError(t, err, "temporarily_unavailable", 503)
}

func TestMachineDispatchByExactTyp(t *testing.T) {
	m := newMachineFixture(t)
	w := m.verifier(t, nil)
	now := time.Now().Unix()
	confused, _ := SignES256(map[string]any{
		"iss": machineOrigin, "sub": "machine:expenses-a", "email": "a@example.com", "email_verified": true,
		"client_id": "expenses-b", "aud": machineResourc, "scope": "expenses:read", "identity_type": "machine",
		"token_type": "machine", "cnf": map[string]any{"jkt": m.machine.JKT}, "iat": now, "exp": now + 600, "jti": newJTI(),
	}, "resource-1", m.resourceKey.Private, "at+jwt")
	for name, token := range map[string]string{
		"unknown typ":         m.token(t, nil, "unknown+jwt"),
		"ID-JAG typ":          m.token(t, nil, "oauth-id-jag+jwt"),
		"user typ":            m.token(t, nil, "at+jwt"),
		"user identity":       m.token(t, map[string]any{"identity_type": "user", "email": "a@example.com"}, ""),
		"machine with email":  m.token(t, map[string]any{"email": "a@example.com", "email_verified": true}, ""),
		"confused user token": confused,
		"wrong audience":      m.token(t, map[string]any{"aud": "https://other.example/api"}, ""),
		"wrong issuer":        m.token(t, map[string]any{"iss": "https://other.example"}, ""),
		// Without a cnf.jkt the token is not bound to a key, so any key's
		// proof would verify: the claim check must refuse it first.
		"missing cnf":     m.token(t, map[string]any{"cnf": nil}, ""),
		"cnf without jkt": m.token(t, map[string]any{"cnf": map[string]any{}}, ""),
		"cnf as array":    m.token(t, map[string]any{"cnf": []any{m.machine.JKT}}, ""),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := w.Verify(m.request(t, token, m.machine), Policy{})
			expectAuthError(t, err, "invalid_token", 401)
		})
	}
}

func TestMachineProofMismatches(t *testing.T) {
	m := newMachineFixture(t)
	w := m.verifier(t, nil)
	token := m.token(t, nil, "")
	target := machineResourc + "/expenses"
	proof := func(in DPoPProofInput) string {
		p, err := CreateDPoPProof(in)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	for name, p := range map[string]string{
		"method":      proof(DPoPProofInput{Key: m.machine, Method: "POST", URL: target, AccessToken: token}),
		"URL":         proof(DPoPProofInput{Key: m.machine, Method: "GET", URL: machineResourc + "/other", AccessToken: token}),
		"no ath":      proof(DPoPProofInput{Key: m.machine, Method: "GET", URL: target}),
		"foreign key": proof(DPoPProofInput{Key: mustKeyPair(t), Method: "GET", URL: target, AccessToken: token}),
	} {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest("GET", target, nil)
			r.Header.Set("Authorization", "DPoP "+token)
			r.Header.Set("DPoP", p)
			_, err := w.Verify(r, Policy{})
			expectAuthError(t, err, "invalid_dpop_proof", 401)
		})
	}
}

// TestNewNeverGeneratesASigningKey is the test half of Success Criterion 5.
func TestNewNeverGeneratesASigningKey(t *testing.T) {
	f := newCoreFixture(t)
	options := f.options(t)
	options.SigningKey = nil
	_, err := New(testHost, options)
	var configErr *ConfigError
	if !errors.As(err, &configErr) || configErr.Message != "signingKey is required" {
		t.Fatalf("want signingKey is required, got %v", err)
	}
}

func TestRegisterRoutes(t *testing.T) {
	f := newCoreFixture(t)
	w := f.sdk(t)
	mux := http.NewServeMux()
	w.RegisterRoutes(mux)
	mux.Handle("GET /api/expenses", w.Protect(Policy{Scopes: []string{"read"}})(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		auth, ok := AuthFromContext(r.Context())
		if !ok {
			t.Error("no auth in context")
		}
		_, _ = rw.Write([]byte(auth.Subject))
	})))
	for _, path := range []string{
		"/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource",
		"/.well-known/oauth-protected-resource/api", "/.well-known/jwks.json",
	} {
		if code := serve(t, mux, "GET", path, nil).Code; code != 200 {
			t.Errorf("%s: %d", path, code)
		}
	}
	token := f.exchange(t, w, f.assertion(t, f.weldallKey, "w1")).body["access_token"].(string)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, protectedRequest(t, f.deviceKey, token, testOrigin+"/api/expenses", "GET"))
	if recorder.Code != 200 || recorder.Body.String() != "user-1" {
		t.Fatalf("protected route: %d %s", recorder.Code, recorder.Body)
	}
	recorder = serve(t, mux, "GET", "/api/expenses", nil)
	if recorder.Code != 401 || recorder.Body.String() != `{"error":"invalid_token","error_description":"DPoP authorization required"}` {
		t.Fatalf("unauthenticated: %d %s", recorder.Code, recorder.Body)
	}
}
