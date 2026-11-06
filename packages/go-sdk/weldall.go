package weldall

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Options configures a Weldall-protected resource. See New.
type Options struct {
	// Resource is the resource identifier tokens are issued for: an absolute
	// HTTPS URL, a path is allowed, a query is not.
	Resource string
	// PublicOrigin is the resource's public origin; it is the token issuer
	// and the origin DPoP proofs are checked against.
	PublicOrigin string
	// ClientID is the client ID Weldall uses at this resource.
	ClientID string
	// SupportedScopes are the scopes this resource grants.
	SupportedScopes []string
	// SigningKey is the resource's own ES256 key. Exactly one of SigningKey
	// and SigningProvider is required; the SDK never generates a key.
	SigningKey      *DirectSigningKey
	SigningProvider SigningKeyProvider
	// ReplayStore records one-time values. Required: pass ReplayDisabled
	// to opt out explicitly, or InMemory for a single replica.
	ReplayStore ReplayStore
	// DiscoveryTimeout bounds each discovery request (100ms–30s, default 5s).
	DiscoveryTimeout time.Duration
	// DiscoveryProxyOrigin fetches Weldall metadata and keys through another
	// origin; the issuer is still the Weldall host.
	DiscoveryProxyOrigin string
	// AllowInsecureLoopback permits http:// for localhost and 127.0.0.1.
	AllowInsecureLoopback bool
	// Skills publishes agent skills at SkillCatalogPath when set.
	Skills *SkillProvider
	// HTTPClient is used for discovery; nil means http.DefaultClient.
	HTTPClient *http.Client
	// Now overrides the clock, for tests.
	Now func() time.Time
}

// Policy is a route's scope requirement. Every scope in Scopes is required;
// when AnyScopes is non-empty, at least one of them is required as well. An
// empty policy still requires a valid Weldall request.
type Policy struct {
	Scopes    []string
	AnyScopes []string
}

// Principal identifies the caller of a verified request.
type Principal struct {
	Type          string `json:"type"`
	Subject       string `json:"subject"`
	Email         string `json:"email,omitempty"`
	EmailVerified bool   `json:"emailVerified,omitempty"`
	ClientID      string `json:"clientId,omitempty"`
}

// AuthContext is the verified identity of a request. IdentityType is "user"
// for an employee or "machine" for a machine client.
type AuthContext struct {
	IdentityType  string    `json:"identityType"`
	Identity      Principal `json:"identity"`
	Subject       string    `json:"subject"`
	Email         string    `json:"email,omitempty"`
	EmailVerified bool      `json:"emailVerified,omitempty"`
	ClientID      string    `json:"clientId"`
	Scopes        []string  `json:"scopes"`
	TokenID       string    `json:"tokenId"`
}

// Weldall protects one resource: it verifies requests, exchanges ID-JAGs
// for access tokens, and serves the protocol's metadata endpoints. It is
// safe for concurrent use; create one per resource at startup.
type Weldall struct {
	host            string
	issuer          string
	resource        string
	clientID        string
	supportedScopes []string
	tokenEndpoint   string
	skillsEndpoint  string
	skills          *SkillProvider
	replay          ReplayStore
	signing         SigningKeyProvider
	discovery       *discovery
	now             func() time.Time
}

// New validates options and returns a Weldall for the resource. host is the
// Weldall origin, for example https://weldall.example.com. New performs no
// network I/O; call Ready to fetch Weldall's keys at startup.
func New(host string, options Options) (*Weldall, error) {
	if host == "" {
		return nil, configError("Weldall host is required")
	}
	insecure := options.AllowInsecureLoopback
	hostURL, err := parseConfigURL(host, "Weldall host", true, insecure)
	if err != nil {
		return nil, err
	}
	proxyURL := hostURL
	if options.DiscoveryProxyOrigin != "" {
		if proxyURL, err = parseConfigURL(options.DiscoveryProxyOrigin, "discoveryProxyOrigin", true, insecure); err != nil {
			return nil, err
		}
	}
	publicURL, err := parseConfigURL(options.PublicOrigin, "publicOrigin", true, insecure)
	if err != nil {
		return nil, err
	}
	resourceURL, err := parseConfigURL(options.Resource, "resource", false, insecure)
	if err != nil {
		return nil, err
	}
	if resourceURL.search() != "" {
		return nil, configError("resource must not contain a query")
	}
	if strings.TrimFunc(options.ClientID, isJSWhitespace) == "" {
		return nil, configError("clientId is required")
	}
	scopes, err := uniqueScopes(options.SupportedScopes, "supportedScopes")
	if err != nil {
		return nil, err
	}
	timeout := options.DiscoveryTimeout
	if timeout == 0 {
		timeout = 5 * time.Second
	}
	if timeout < 100*time.Millisecond || timeout > 30*time.Second {
		return nil, configError("discoveryTimeout must be between 100ms and 30s")
	}
	if options.ReplayStore == nil {
		return nil, configError("replayStore is required")
	}
	if options.Skills != nil {
		if (options.Skills.Items != nil) == (options.Skills.Load != nil) {
			return nil, configError("skills must configure exactly one of items or load")
		}
		if _, disabled := options.ReplayStore.(disabledReplayStore); disabled {
			return nil, configError("skill publication requires replay protection")
		}
	}
	var signing SigningKeyProvider
	switch {
	case options.SigningKey != nil && options.SigningProvider != nil:
		return nil, configError("configure exactly one of signingKey and signingProvider")
	case options.SigningKey != nil:
		if signing, err = newDirectProvider(*options.SigningKey); err != nil {
			return nil, err
		}
	case options.SigningProvider != nil:
		signing = options.SigningProvider
	default:
		return nil, configError("signingKey is required")
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	issuer := publicURL.origin()
	w := &Weldall{
		host:            hostURL.origin(),
		issuer:          issuer,
		resource:        resourceURL.String(),
		clientID:        options.ClientID,
		supportedScopes: scopes,
		tokenEndpoint:   issuer + "/oauth/token",
		skills:          options.Skills,
		replay:          options.ReplayStore,
		signing:         signing,
		discovery:       newDiscovery(hostURL.origin(), proxyURL.origin(), timeout, options.HTTPClient, now),
		now:             now,
	}
	if options.Skills != nil {
		w.skillsEndpoint = issuer + SkillCatalogPath
	}
	return w, nil
}

// parseConfigURL mirrors core.ts parseUrl.
func parseConfigURL(value, label string, originOnly, allowInsecureLoopback bool) (*parsedURL, error) {
	u, err := parseURL(value)
	if err != nil {
		return nil, configError(label + " must be an absolute URL")
	}
	if u.scheme != "https" && !(allowInsecureLoopback && u.isLoopback() && u.scheme == "http") {
		return nil, configError(label + " must use HTTPS")
	}
	if u.hasCredentials() || u.hash() != "" || originOnly && (u.path != "/" || u.search() != "") {
		return nil, configError(label + " must be an origin without credentials, path, query, or fragment")
	}
	return u, nil
}

// Host is the Weldall origin.
func (w *Weldall) Host() string { return w.host }

// Issuer is the resource's public origin, the issuer of its access tokens.
func (w *Weldall) Issuer() string { return w.issuer }

// Resource is the normalised resource identifier.
func (w *Weldall) Resource() string { return w.resource }

// TokenEndpoint is the resource's token endpoint URL.
func (w *Weldall) TokenEndpoint() string { return w.tokenEndpoint }

// SkillsEndpoint is the skill catalog URL, or "" when no skills are published.
func (w *Weldall) SkillsEndpoint() string { return w.skillsEndpoint }

// Ready fetches Weldall's metadata and keys and validates the signing
// configuration, so a misconfiguration fails at startup rather than on the
// first request.
func (w *Weldall) Ready(ctx context.Context) error {
	if err := w.discovery.ready(ctx); err != nil {
		return err
	}
	_, err := validatedJWKS(ctx, w.signing)
	return err
}

func (w *Weldall) unix() int64 { return w.now().Unix() }

// verifyWeldallSigned verifies a token signed by Weldall itself, retrying
// once with a JWKS refresh. rethrowFirst decides which first-attempt errors
// skip the retry.
func (w *Weldall) verifyWeldallSigned(ctx context.Context, token, typ string, options claimOptions, rethrowFirst func(*AuthError) bool, final *AuthError) (map[string]any, error) {
	validate := func(refresh bool) (map[string]any, error) {
		kid, jwk, err := w.discovery.getSigningKey(ctx, token, typ, refresh)
		if err != nil {
			return nil, err
		}
		key, err := jwk.minimal().publicKey()
		if err != nil {
			return nil, err
		}
		header, raw, err := verifyCompact(token, verifyWithKey(key))
		if err != nil {
			return nil, err
		}
		options.now = w.unix()
		payload, err := validateClaims(header, raw, options)
		if err != nil {
			return nil, err
		}
		if header["kid"] != kid {
			return nil, errors.New("kid")
		}
		return payload, nil
	}
	payload, err := validate(false)
	if err == nil {
		return payload, nil
	}
	if authErr, ok := asAuthError(err); ok && rethrowFirst(authErr) {
		return nil, err
	}
	payload, err = validate(true)
	if err == nil {
		return payload, nil
	}
	if authErr, ok := asAuthError(err); ok && authErr.Code == "temporarily_unavailable" {
		return nil, err
	}
	return nil, final
}

func isUnavailable(err *AuthError) bool { return err.Code == "temporarily_unavailable" }
func anyAuthError(*AuthError) bool      { return true }

func (w *Weldall) verifyIDJAGAssertion(ctx context.Context, assertion string) (map[string]any, error) {
	payload, err := w.verifyWeldallSigned(ctx, assertion, idJAGTyp, claimOptions{
		issuer:         w.host,
		audience:       w.issuer,
		requiredClaims: []string{"iss", "sub", "email", "email_verified", "aud", "exp", "iat", "jti"},
		maxTokenAge:    5 * 60,
		clockTolerance: clockToleranceSecs,
	}, anyAuthError, newAuthError("invalid_grant", "ID-JAG validation failed", 0))
	if err != nil {
		return nil, err
	}
	scopes, scopeOK := ParseScope(payload["scope"])
	if !idJAGClaimsValid(payload, w.issuer, w.resource, w.clientID) || !scopeOK {
		return nil, newAuthError("invalid_grant", "invalid ID-JAG claims", 0)
	}
	for _, scope := range scopes {
		if !contains(w.supportedScopes, scope) {
			return nil, newAuthError("invalid_scope", "ID-JAG requested an unsupported scope", 0)
		}
	}
	return payload, nil
}

func (w *Weldall) verifySkillAssertion(ctx context.Context, assertion string) error {
	payload, err := w.verifyWeldallSigned(ctx, assertion, SkillAssertionType, claimOptions{
		issuer:         w.host,
		audience:       w.skillsEndpoint,
		requiredClaims: []string{"iss", "sub", "aud", "resource", "purpose", "exp", "iat", "jti"},
		maxTokenAge:    60,
		clockTolerance: clockToleranceSecs,
	}, isUnavailable, newAuthError("invalid_token", "skill assertion validation failed", http.StatusUnauthorized))
	if err != nil {
		return err
	}
	if payload["iss"] != w.host || payload["sub"] != w.host || payload["aud"] != w.skillsEndpoint ||
		payload["resource"] != w.resource || payload["purpose"] != "skills:read" || !validLifetime(payload, 60) {
		return newAuthError("invalid_token", "invalid skill assertion claims", http.StatusUnauthorized)
	}
	jti, _ := payload["jti"].(string)
	exp, _ := jsInteger(payload["exp"])
	return consumeReplay(ctx, w.replay, "skills", jti, time.Unix(exp+6, 0),
		newAuthError("invalid_token", "skill assertion was already used", http.StatusUnauthorized))
}

func (w *Weldall) verifyMachineToken(ctx context.Context, token string) (map[string]any, error) {
	return w.verifyWeldallSigned(ctx, token, MachineTokenTyp, claimOptions{
		issuer:         w.host,
		audience:       w.resource,
		requiredClaims: []string{"iss", "sub", "aud", "exp", "iat", "jti"},
		maxTokenAge:    5 * 60,
		clockTolerance: clockToleranceSecs,
	}, isUnavailable, newAuthError("invalid_token", "machine token validation failed", http.StatusUnauthorized))
}

func (w *Weldall) verifyUserToken(ctx context.Context, token string) (map[string]any, error) {
	keys, err := validatedJWKS(ctx, w.signing)
	if err != nil {
		return nil, err
	}
	resolve := func(header map[string]any) (*ecdsa.PublicKey, error) {
		kid, ok := header["kid"].(string)
		if header["alg"] != "ES256" || header["typ"] != accessTokenTyp || jsTruthy(header["crit"]) || !ok {
			return nil, errors.New("invalid header")
		}
		for _, key := range keys {
			if key.Kid == kid {
				return key.minimal().publicKey()
			}
		}
		return nil, errors.New("unknown kid")
	}
	failed := newAuthError("invalid_token", "access token validation failed", http.StatusUnauthorized)
	header, raw, err := verifyCompact(token, resolve)
	if err != nil {
		return nil, failed
	}
	payload, err := validateClaims(header, raw, claimOptions{
		issuer:         w.issuer,
		audience:       w.resource,
		requiredClaims: []string{"iss", "sub", "email", "email_verified", "aud", "exp", "iat", "jti"},
		maxTokenAge:    10 * 60,
		clockTolerance: clockToleranceSecs,
		now:            w.unix(),
	})
	if err != nil {
		return nil, failed
	}
	return payload, nil
}

// dpopAuthorization matches exactly one DPoP token with no whitespace or
// comma, as the TypeScript SDK's /^DPoP ([^\s,]+)$/ does.
var dpopAuthorization = regexp.MustCompile(`^DPoP ([^,` + jsWhitespaceClass + `]+)$`)

// headerValue mirrors Fetch's Headers.get: repeated headers joined by ", ".
func headerValue(header http.Header, name string) (string, bool) {
	values := header.Values(name)
	return strings.Join(values, ", "), len(values) > 0
}

// Verify checks a request's DPoP-bound access token and proof and applies
// the scope policy. Every failure is an *AuthError carrying the status and
// OAuth error to answer with (WriteOAuthError renders it).
func (w *Weldall) Verify(r *http.Request, policy Policy) (*AuthContext, error) {
	auth, err := w.verify(r, policy)
	if err == nil {
		return auth, nil
	}
	if authErr, ok := asAuthError(err); ok {
		return nil, authErr
	}
	return nil, newAuthError("invalid_token", "request rejected", http.StatusUnauthorized)
}

func (w *Weldall) verify(r *http.Request, policy Policy) (*AuthContext, error) {
	ctx := r.Context()
	required, err := uniqueScopes(policy.Scopes, "policy.scopes")
	if err != nil {
		return nil, err
	}
	anyOf, err := uniqueScopes(policy.AnyScopes, "policy.anyScopes")
	if err != nil {
		return nil, err
	}
	authorization, _ := headerValue(r.Header, "Authorization")
	match := dpopAuthorization.FindStringSubmatch(authorization)
	proof, _ := headerValue(r.Header, "DPoP")
	if match == nil || proof == "" || strings.Contains(proof, ",") {
		return nil, newAuthError("invalid_token", "DPoP authorization required", http.StatusUnauthorized)
	}
	accessToken := match[1]
	header, err := decodeProtectedHeader(accessToken)
	profile := ""
	if err == nil {
		switch header["typ"] {
		case accessTokenTyp:
			profile = "user"
		case MachineTokenTyp:
			profile = "machine"
		}
	}
	if profile == "" {
		return nil, newAuthError("invalid_token", "unsupported access token profile", http.StatusUnauthorized)
	}
	var payload map[string]any
	maxLifetime := int64(userTokenSeconds)
	if profile == "user" {
		payload, err = w.verifyUserToken(ctx, accessToken)
	} else {
		payload, err = w.verifyMachineToken(ctx, accessToken)
		maxLifetime = MachineTokenSeconds
	}
	if err != nil {
		return nil, err
	}
	granted, scopeOK := ParseScope(payload["scope"])
	subject, _ := payload["sub"].(string)
	var profileValid bool
	if profile == "user" {
		_, hasIdentityType := payload["identity_type"]
		_, hasTokenType := payload["token_type"]
		profileValid = payload["client_id"] == w.clientID && hasVerifiedEmail(payload) &&
			subject != "" && !strings.HasPrefix(subject, "machine:") && !hasIdentityType && !hasTokenType
	} else {
		clientID, _ := payload["client_id"].(string)
		_, hasEmail := payload["email"]
		_, hasEmailVerified := payload["email_verified"]
		profileValid = machineIDPattern.MatchString(clientID) && subject == "machine:"+clientID &&
			payload["azp"] == clientID && payload["identity_type"] == "machine" &&
			payload["token_type"] == "machine" && !hasEmail && !hasEmailVerified
	}
	if payload["aud"] != w.resource || subject == "" || !profileValid || !validLifetime(payload, maxLifetime) ||
		!scopeOK || !allContained(granted, w.supportedScopes) || !validCnf(payload["cnf"]) {
		return nil, newAuthError("invalid_token", "invalid access token claims", http.StatusUnauthorized)
	}
	publicURL, err := w.publicRequestURL(r)
	if err != nil {
		return nil, newAuthError("invalid_dpop_proof", "invalid request URL", http.StatusUnauthorized)
	}
	if _, err := VerifyStrictDPoP(ctx, proof, VerifyDPoPInput{
		Method:      r.Method,
		URL:         publicURL,
		Replay:      w.replay,
		AccessToken: accessToken,
		ExpectedJKT: cnfJKT(payload),
		Now:         w.now(),
	}); err != nil {
		if authErr, ok := asAuthError(err); ok && authErr.Code == "invalid_dpop_proof" {
			remapped := *authErr
			remapped.Status = http.StatusUnauthorized
			return nil, &remapped
		}
		return nil, err
	}
	missing := !allContained(required, granted)
	if missing || len(anyOf) > 0 && !anyContained(anyOf, granted) {
		err := newAuthError("insufficient_scope", "required scope is missing", http.StatusForbidden)
		err.RequiredScopes = append(append([]string{}, required...), anyOf...)
		return nil, err
	}
	jti, _ := payload["jti"].(string)
	if profile == "machine" {
		clientID, _ := payload["client_id"].(string)
		return &AuthContext{
			IdentityType: "machine",
			Identity:     Principal{Type: "machine", Subject: subject, ClientID: clientID},
			Subject:      subject,
			ClientID:     clientID,
			Scopes:       granted,
			TokenID:      jti,
		}, nil
	}
	email, _ := payload["email"].(string)
	return &AuthContext{
		IdentityType:  "user",
		Identity:      Principal{Type: "user", Subject: subject, Email: email, EmailVerified: true},
		Subject:       subject,
		Email:         email,
		EmailVerified: true,
		ClientID:      w.clientID,
		Scopes:        granted,
		TokenID:       jti,
	}, nil
}

// publicRequestURL rebuilds the request URL on the configured public origin:
// only the path is taken from the request, so a network-path request such
// as "//attacker.example/x" stays on this origin.
func (w *Weldall) publicRequestURL(r *http.Request) (string, error) {
	path := r.URL.EscapedPath()
	if !strings.HasPrefix(path, "/") && !strings.HasPrefix(path, `\`) {
		path = "/" + path
	}
	u, err := parseURL(w.issuer + path)
	if err != nil {
		return "", err
	}
	if r.URL.RawQuery != "" {
		u.query, u.hasQuery = percentEncode(r.URL.RawQuery, isSpecialQueryEncoded), true
	}
	return u.String(), nil
}

func allContained(values, set []string) bool {
	for _, value := range values {
		if !contains(set, value) {
			return false
		}
	}
	return true
}

func anyContained(values, set []string) bool {
	for _, value := range values {
		if contains(set, value) {
			return true
		}
	}
	return false
}
