package weldall

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var machineIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// absoluteURL validates a URL the way machine.ts does: https (or http on a
// loopback host), no credentials, query or fragment, and — for an origin —
// no path.
func absoluteURL(value, label string, originOnly bool) (*parsedURL, error) {
	u, err := parseURL(value)
	if err != nil {
		return nil, configError(label + " must be an absolute URL")
	}
	if u.scheme != "https" && !(u.isLoopback() && u.scheme == "http") {
		return nil, configError(label + " must use HTTPS")
	}
	if u.hasCredentials() || u.hash() != "" || u.search() != "" || originOnly && u.path != "/" {
		return nil, configError(label + " must be an origin without credentials, path, query, or fragment")
	}
	return u, nil
}

// MachineAssertionInput configures CreateMachineClientAssertion.
type MachineAssertionInput struct {
	ClientID      string
	TokenEndpoint string
	Kid           string
	PrivateJWK    PrivateJWK
	Now           time.Time
	JTI           string
}

// CreateMachineClientAssertion creates an RFC 7523 private_key_jwt client
// assertion: iss = sub = client ID, aud = token endpoint, 60 s lifetime.
func CreateMachineClientAssertion(in MachineAssertionInput) (string, error) {
	if !machineIDPattern.MatchString(in.ClientID) {
		return "", configError("invalid machine client ID")
	}
	if !machineIDPattern.MatchString(in.Kid) {
		return "", configError("invalid machine key ID")
	}
	endpoint, err := absoluteURL(in.TokenEndpoint, "tokenEndpoint", false)
	if err != nil {
		return "", err
	}
	private, err := in.PrivateJWK.privateKey()
	if err != nil {
		return "", err
	}
	now := unixNow(in.Now)
	jti := in.JTI
	if jti == "" {
		jti = newJTI()
	}
	payload := map[string]any{
		"iss": in.ClientID,
		"sub": in.ClientID,
		"aud": endpoint.String(),
		"iat": now,
		"exp": now + 60,
		"jti": jti,
	}
	return signCompact(map[string]any{"alg": "ES256", "typ": "JWT", "kid": in.Kid}, payload, private)
}

// MachineTokenInput configures RequestMachineToken.
type MachineTokenInput struct {
	Issuer        string // the Weldall origin
	ClientID      string
	Resource      string
	Scopes        []string
	Kid           string
	Key           KeyPair // the machine client's registered key, also its DPoP key
	TokenEndpoint string  // default: {Issuer}/api/auth/oauth2/token
	HTTPClient    *http.Client
}

// MachineToken is a DPoP-bound access token issued to a machine client.
type MachineToken struct {
	AccessToken string
	TokenType   string
	ExpiresIn   int
	Scope       string
}

// RequestMachineToken obtains a DPoP-bound access token with the client
// credentials grant, authenticating with a private_key_jwt assertion.
func RequestMachineToken(ctx context.Context, in MachineTokenInput) (*MachineToken, error) {
	issuerURL, err := absoluteURL(in.Issuer, "issuer", true)
	if err != nil {
		return nil, err
	}
	issuer := issuerURL.origin()
	endpointValue := in.TokenEndpoint
	if endpointValue == "" {
		endpointValue = issuer + "/api/auth/oauth2/token"
	}
	endpointURL, err := absoluteURL(endpointValue, "tokenEndpoint", false)
	if err != nil {
		return nil, err
	}
	tokenEndpoint := endpointURL.String()
	scopes, err := uniqueScopes(in.Scopes, "scopes")
	if err != nil {
		return nil, configError("scopes must contain unique valid OAuth tokens")
	}
	if len(scopes) == 0 {
		return nil, configError("at least one scope is required")
	}
	resourceURL, err := absoluteURL(in.Resource, "resource", false)
	if err != nil {
		return nil, err
	}
	assertion, err := CreateMachineClientAssertion(MachineAssertionInput{
		ClientID:      in.ClientID,
		TokenEndpoint: tokenEndpoint,
		Kid:           in.Kid,
		PrivateJWK:    in.Key.Private,
	})
	if err != nil {
		return nil, err
	}
	proof, err := CreateDPoPProof(DPoPProofInput{Key: in.Key, Method: http.MethodPost, URL: tokenEndpoint})
	if err != nil {
		return nil, err
	}
	form := url.Values{
		"grant_type":            {"client_credentials"},
		"client_id":             {in.ClientID},
		"client_assertion_type": {PrivateKeyJWTType},
		"client_assertion":      {assertion},
		"resource":              {resourceURL.String()},
		"scope":                 {strings.Join(scopes, " ")},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("DPoP", proof)
	client := in.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	body, _ := decodeJSONObject(bytes.TrimSpace(data))
	if response.StatusCode < 200 || response.StatusCode > 299 {
		code, ok := body["error"].(string)
		if !ok {
			code = "server_error"
		}
		return nil, newAuthError(code, "machine token request rejected", response.StatusCode)
	}
	accessToken, ok := body["access_token"].(string)
	scope, scopeOK := body["scope"].(string)
	expiresIn, _ := jsNumber(body["expires_in"])
	if !ok || body["token_type"] != "DPoP" || expiresIn != MachineTokenSeconds || !scopeOK {
		return nil, newAuthError("server_error", "invalid machine token response", http.StatusInternalServerError)
	}
	return &MachineToken{AccessToken: accessToken, TokenType: "DPoP", ExpiresIn: MachineTokenSeconds, Scope: scope}, nil
}
