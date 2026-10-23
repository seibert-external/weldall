package weldall

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const (
	jwksTTL                 = 60 * time.Second
	unknownKidRefreshPeriod = 5 * time.Second
	maxDiscoveryResponse    = 256_000
)

// discovery fetches and caches Weldall's authorization-server metadata and
// JWKS. Metadata is cached for the life of the process; the JWKS for 60 s.
// Concurrent callers share one in-flight fetch, and a token signed with an
// unknown kid forces a refresh at most once every 5 s.
type discovery struct {
	issuer      string // Weldall's canonical origin
	fetchOrigin string // where to fetch from (a discovery proxy, or the issuer)
	timeout     time.Duration
	client      *http.Client
	now         func() time.Time

	mu               sync.Mutex
	metadata         *discoveryMetadata
	metadataCall     *call
	keys             map[string]JWK
	jwksCall         *call
	jwksExpiresAt    time.Time
	unknownRefreshAt time.Time
}

type discoveryMetadata struct {
	issuer  string
	jwksURI *parsedURL
}

// call is one shared in-flight operation.
type call struct {
	done chan struct{}
	err  error
}

func newDiscovery(issuer, fetchOrigin string, timeout time.Duration, client *http.Client, now func() time.Time) *discovery {
	if client == nil {
		client = http.DefaultClient
	}
	// Discovery must never follow redirects, whatever the injected client does.
	noRedirect := *client
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &discovery{issuer: issuer, fetchOrigin: fetchOrigin, timeout: timeout, client: &noRedirect, now: now, keys: map[string]JWK{}}
}

func (d *discovery) ready(ctx context.Context) error { return d.refreshJWKS(ctx, false) }

// getSigningKey checks a Weldall-signed token's header and returns the key
// it names, refreshing the JWKS for an unknown kid or when the caller saw a
// validation failure.
func (d *discovery) getSigningKey(ctx context.Context, token, expectedTyp string, refreshForFailure bool) (string, JWK, error) {
	invalidHeader := newAuthError("invalid_grant", "invalid signed assertion header", 0)
	header, err := decodeProtectedHeader(token)
	if err != nil || header["alg"] != "ES256" || header["typ"] != expectedTyp || jsTruthy(header["crit"]) {
		return "", JWK{}, invalidHeader
	}
	kid, ok := header["kid"].(string)
	if !ok || kid == "" {
		return "", JWK{}, invalidHeader
	}
	if err := d.refreshJWKS(ctx, false); err != nil {
		return "", JWK{}, err
	}
	d.mu.Lock()
	jwk, known := d.keys[kid]
	refresh := (refreshForFailure || !known) && !d.now().Before(d.unknownRefreshAt)
	if refresh {
		d.unknownRefreshAt = d.now().Add(unknownKidRefreshPeriod)
	}
	d.mu.Unlock()
	if refresh {
		if err := d.refreshJWKS(ctx, true); err != nil {
			return "", JWK{}, err
		}
		d.mu.Lock()
		jwk, known = d.keys[kid]
		d.mu.Unlock()
	}
	if !known {
		return "", JWK{}, newAuthError("invalid_grant", "unknown Weldall signing key", 0)
	}
	return kid, jwk, nil
}

// share runs fn once for all concurrent callers that find *slot occupied.
func (d *discovery) share(ctx context.Context, slot **call, skip func() bool, fn func(context.Context) error) error {
	d.mu.Lock()
	if c := *slot; c != nil {
		d.mu.Unlock()
		select {
		case <-c.done:
			return c.err
		case <-ctx.Done():
			return newAuthError("temporarily_unavailable", "Weldall discovery failed", http.StatusServiceUnavailable)
		}
	}
	if skip != nil && skip() {
		d.mu.Unlock()
		return nil
	}
	c := &call{done: make(chan struct{})}
	*slot = c
	d.mu.Unlock()
	// The shared fetch outlives any single caller's cancellation.
	c.err = fn(context.WithoutCancel(ctx))
	d.mu.Lock()
	*slot = nil
	d.mu.Unlock()
	close(c.done)
	return c.err
}

func (d *discovery) discover(ctx context.Context) (*discoveryMetadata, error) {
	d.mu.Lock()
	if d.metadata != nil {
		m := d.metadata
		d.mu.Unlock()
		return m, nil
	}
	d.mu.Unlock()
	err := d.share(ctx, &d.metadataCall, func() bool { return d.metadata != nil }, d.fetchMetadata)
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.metadata, nil
}

func (d *discovery) fetchMetadata(ctx context.Context) error {
	failed := newAuthError("temporarily_unavailable", "Weldall discovery failed", http.StatusServiceUnavailable)
	value, err := d.fetchJSON(ctx, d.fetchOrigin+"/.well-known/oauth-authorization-server")
	if err != nil {
		return failed
	}
	issuer, jwksURI := value["issuer"], value["jwks_uri"]
	uri, ok := jwksURI.(string)
	if issuer != d.issuer || !ok {
		return failed
	}
	parsed, err := parseURL(uri)
	if err != nil || parsed.origin() != d.issuer || parsed.hasCredentials() || parsed.search() != "" || parsed.hash() != "" {
		return failed
	}
	d.mu.Lock()
	d.metadata = &discoveryMetadata{issuer: d.issuer, jwksURI: parsed}
	d.mu.Unlock()
	return nil
}

func (d *discovery) refreshJWKS(ctx context.Context, force bool) error {
	skip := func() bool {
		return !force && len(d.keys) > 0 && d.now().Before(d.jwksExpiresAt)
	}
	return d.share(ctx, &d.jwksCall, skip, func(ctx context.Context) error {
		metadata, err := d.discover(ctx)
		if err != nil {
			return err
		}
		keys, err := d.fetchKeys(ctx, metadata)
		if err != nil {
			return newAuthError("temporarily_unavailable", "Weldall JWKS fetch failed", http.StatusServiceUnavailable)
		}
		d.mu.Lock()
		d.keys = keys
		d.jwksExpiresAt = d.now().Add(jwksTTL)
		d.mu.Unlock()
		return nil
	})
}

func (d *discovery) fetchKeys(ctx context.Context, metadata *discoveryMetadata) (map[string]JWK, error) {
	// Fetch through the fetch origin, keeping only the path: a discovery
	// proxy serves the issuer's JWKS under the same path.
	value, err := d.fetchJSON(ctx, d.fetchOrigin+metadata.jwksURI.path)
	if err != nil {
		return nil, err
	}
	rawKeys, ok := value["keys"].([]any)
	if !ok || len(rawKeys) < 1 || len(rawKeys) > 20 {
		return nil, errors.New("invalid JWKS size")
	}
	keys := make(map[string]JWK, len(rawKeys))
	for _, candidate := range rawKeys {
		if _, ok := candidate.(map[string]any); !ok {
			return nil, errors.New("invalid JWK")
		}
		encoded, _ := json.Marshal(candidate)
		var jwk JWK
		if err := json.Unmarshal(encoded, &jwk); err != nil {
			return nil, err
		}
		if jwk.Kid == "" || jwk.kidNotString {
			return nil, errors.New("invalid JWK kid")
		}
		if _, duplicate := keys[jwk.Kid]; duplicate {
			return nil, errors.New("duplicate JWK kid")
		}
		if err := AssertPublicP256(jwk); err != nil {
			return nil, err
		}
		keys[jwk.Kid] = jwk
	}
	return keys, nil
}

func (d *discovery) fetchJSON(ctx context.Context, target string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, d.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	response, err := d.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, errors.New("HTTP " + strconv.Itoa(response.StatusCode))
	}
	if contentType := mediaType(response.Header.Get("Content-Type")); contentType != "application/json" &&
		contentType != "application/jwk-set+json" {
		return nil, errors.New("unexpected content type")
	}
	if response.ContentLength > maxDiscoveryResponse {
		return nil, errors.New("response too large")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxDiscoveryResponse+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxDiscoveryResponse {
		return nil, errors.New("response too large")
	}
	return decodeJSONObject(body)
}
