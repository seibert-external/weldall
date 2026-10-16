package weldall

import (
	"context"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type authContextKey struct{}

// Protect returns middleware that verifies each request against policy. A
// rejected request gets the OAuth error response; an accepted one reaches
// next with its AuthContext available through AuthFromContext.
func (w *Weldall) Protect(policy Policy) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
			auth, err := w.Verify(r, policy)
			if err != nil {
				WriteOAuthError(rw, err)
				return
			}
			next.ServeHTTP(rw, r.WithContext(context.WithValue(r.Context(), authContextKey{}, auth)))
		})
	}
}

// AuthFromContext returns the AuthContext Protect stored for the request.
func AuthFromContext(ctx context.Context) (*AuthContext, bool) {
	auth, ok := ctx.Value(authContextKey{}).(*AuthContext)
	return auth, ok
}

// RegisterRoutes mounts the protocol endpoints Weldall needs on mux:
// authorization-server and protected-resource metadata, the JWKS, the skill
// catalog and the token endpoint. They claim the origin root, so the
// resource cannot share its host with another OAuth server.
func (w *Weldall) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("GET /.well-known/oauth-authorization-server", w.AuthorizationServerMetadataHandler())
	mux.Handle("GET /.well-known/oauth-protected-resource", w.ProtectedResourceMetadataHandler())
	mux.Handle("GET /.well-known/oauth-protected-resource/", w.ProtectedResourceMetadataHandler())
	mux.Handle("GET /.well-known/jwks.json", w.JWKSHandler())
	mux.Handle(SkillCatalogPath, w.SkillsHandler())
	mux.Handle("/oauth/token", w.TokenHandler())
}

// writeJSON writes value without HTML escaping, as JSON.stringify does.
func writeJSON(rw http.ResponseWriter, status int, header http.Header, value any) {
	body, err := marshalJSON(value)
	if err != nil {
		WriteOAuthError(rw, err)
		return
	}
	for key, values := range header {
		rw.Header()[key] = values
	}
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_, _ = rw.Write(body)
}

type authorizationServerMetadata struct {
	Issuer                            string   `json:"issuer"`
	TokenEndpoint                     string   `json:"token_endpoint"`
	JWKSURI                           string   `json:"jwks_uri"`
	GrantTypesSupported               []string `json:"grant_types_supported"`
	ResponseTypesSupported            []string `json:"response_types_supported"`
	TokenEndpointAuthMethodsSupported []string `json:"token_endpoint_auth_methods_supported"`
	DPoPSigningAlgValuesSupported     []string `json:"dpop_signing_alg_values_supported"`
	JWTDPoPDraft                      string   `json:"urn:weldall:jwt-dpop-draft"`
}

// AuthorizationServerMetadataHandler serves RFC 8414 metadata for the
// resource's own token endpoint.
func (w *Weldall) AuthorizationServerMetadataHandler() http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		writeJSON(rw, http.StatusOK, nil, authorizationServerMetadata{
			Issuer:                            w.issuer,
			TokenEndpoint:                     w.tokenEndpoint,
			JWKSURI:                           w.issuer + "/.well-known/jwks.json",
			GrantTypesSupported:               []string{JWTDPoPGrant},
			ResponseTypesSupported:            []string{},
			TokenEndpointAuthMethodsSupported: []string{"none"},
			DPoPSigningAlgValuesSupported:     []string{"ES256"},
			JWTDPoPDraft:                      JWTDPoPDraft,
		})
	})
}

type protectedResourceMetadata struct {
	Resource                      string   `json:"resource"`
	AuthorizationServers          []string `json:"authorization_servers"`
	ScopesSupported               []string `json:"scopes_supported"`
	BearerMethodsSupported        []string `json:"bearer_methods_supported"`
	DPoPSigningAlgValuesSupported []string `json:"dpop_signing_alg_values_supported"`
	WeldallSkillsEndpoint         string   `json:"weldall_skills_endpoint,omitempty"`
}

// ProtectedResourceMetadataHandler serves RFC 9728 protected-resource
// metadata.
func (w *Weldall) ProtectedResourceMetadataHandler() http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		writeJSON(rw, http.StatusOK, nil, protectedResourceMetadata{
			Resource:                      w.resource,
			AuthorizationServers:          []string{w.issuer},
			ScopesSupported:               w.supportedScopes,
			BearerMethodsSupported:        []string{"header"},
			DPoPSigningAlgValuesSupported: []string{"ES256"},
			WeldallSkillsEndpoint:         w.skillsEndpoint,
		})
	})
}

// JWKSHandler serves the keys that verify the resource's access tokens.
func (w *Weldall) JWKSHandler() http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		keys, err := validatedJWKS(r.Context(), w.signing)
		if err != nil {
			WriteOAuthError(rw, err)
			return
		}
		writeJSON(rw, http.StatusOK, nil, map[string]any{"keys": keys})
	})
}

var bearerAuthorization = regexp.MustCompile(`^Bearer ([^,` + jsWhitespaceClass + `]+)$`)

// SkillsHandler serves the skill catalog to Weldall, authenticated by a
// one-time skills assertion. It answers 404 when no skills are configured.
func (w *Weldall) SkillsHandler() http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if w.skills == nil {
			rw.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Method != http.MethodGet {
			rw.Header().Set("Allow", "GET")
			rw.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		authorization, _ := headerValue(r.Header, "Authorization")
		match := bearerAuthorization.FindStringSubmatch(authorization)
		var err error
		if match == nil {
			err = newAuthError("invalid_token", "exactly one Bearer assertion is required", http.StatusUnauthorized)
		} else {
			err = w.verifySkillAssertion(r.Context(), match[1])
		}
		var catalog *SkillCatalog
		if err == nil {
			catalog, err = loadSkillCatalog(r.Context(), w.skills, w.resource)
		}
		if err != nil {
			if _, ok := asAuthError(err); ok {
				WriteOAuthError(rw, err)
				return
			}
			writeJSON(rw, http.StatusServiceUnavailable, http.Header{"Cache-Control": {"no-store"}}, map[string]string{
				"error":             "temporarily_unavailable",
				"error_description": "Skill catalog unavailable",
			})
			return
		}
		writeJSON(rw, http.StatusOK, http.Header{"Cache-Control": {"private, no-store"}}, catalog)
	})
}

const maxTokenFormLength = 64_000

// TokenHandler is the resource's token endpoint: it exchanges a Weldall
// ID-JAG plus a DPoP proof for a DPoP-bound access token.
func (w *Weldall) TokenHandler() http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		response, err := w.exchange(r)
		if err != nil {
			WriteOAuthError(rw, err)
			return
		}
		writeJSON(rw, http.StatusOK, http.Header{"Cache-Control": {"no-store"}, "Pragma": {"no-cache"}}, response)
	})
}

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
	Scope       string `json:"scope"`
}

func (w *Weldall) exchange(r *http.Request) (*tokenResponse, error) {
	ctx := r.Context()
	if r.Method != http.MethodPost {
		return nil, newAuthError("invalid_request", "token endpoint requires POST", 0)
	}
	if mediaType(r.Header.Get("Content-Type")) != "application/x-www-form-urlencoded" {
		return nil, newAuthError("invalid_request", "form content type required", 0)
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxTokenFormLength*4+1))
	if err != nil {
		return nil, newAuthError("invalid_request", "form is too large", 0)
	}
	text := strings.ToValidUTF8(string(raw), "�")
	if len(raw) > maxTokenFormLength*4 || utf16Length(text) > maxTokenFormLength {
		return nil, newAuthError("invalid_request", "form is too large", 0)
	}
	form := parseURLSearchParams(text)
	counts := map[string]int{}
	values := map[string]string{}
	for _, pair := range form {
		counts[pair[0]]++
		values[pair[0]] = pair[1]
	}
	for name := range counts {
		if name != "grant_type" && name != "assertion" {
			return nil, newAuthError("invalid_request", "invalid or duplicate OAuth parameter", 0)
		}
	}
	if counts["grant_type"] != 1 || counts["assertion"] != 1 {
		return nil, newAuthError("invalid_request", "invalid or duplicate OAuth parameter", 0)
	}
	if values["grant_type"] != JWTDPoPGrant {
		return nil, newAuthError("unsupported_grant_type", "", 0)
	}
	proof, _ := headerValue(r.Header, "DPoP")
	if proof == "" || strings.Contains(proof, ",") {
		return nil, newAuthError("invalid_dpop_proof", "exactly one DPoP proof is required", 0)
	}
	jag, err := w.verifyIDJAGAssertion(ctx, values["assertion"])
	if err != nil {
		return nil, err
	}
	jkt := cnfJKT(jag)
	if _, err := VerifyStrictDPoP(ctx, proof, VerifyDPoPInput{
		Method: http.MethodPost, URL: w.tokenEndpoint, Replay: w.replay, ExpectedJKT: jkt, Now: w.now(),
	}); err != nil {
		return nil, err
	}
	jti, _ := jag["jti"].(string)
	exp, _ := jsInteger(jag["exp"])
	if err := consumeReplay(ctx, w.replay, "id-jag", jti, time.Unix(exp+6, 0),
		newAuthError("invalid_grant", "ID-JAG was already used", 0)); err != nil {
		return nil, err
	}
	now := w.unix()
	scope, _ := jag["scope"].(string)
	accessToken, err := signWithProvider(ctx, w.signing, map[string]any{
		"iss":            w.issuer,
		"sub":            jag["sub"],
		"email":          jag["email"],
		"email_verified": true,
		"aud":            w.resource,
		"client_id":      w.clientID,
		"scope":          scope,
		"cnf":            map[string]any{"jkt": jkt},
		"jti":            newJTI(),
		"iat":            now,
		"exp":            now + userTokenSeconds,
	}, accessTokenTyp, now)
	if err != nil {
		return nil, err
	}
	return &tokenResponse{AccessToken: accessToken, TokenType: "DPoP", ExpiresIn: userTokenSeconds, Scope: scope}, nil
}

// parseURLSearchParams parses application/x-www-form-urlencoded text the way
// URLSearchParams does: lenient about malformed escapes (left as is), "+"
// is a space, and empty sequences are skipped.
func parseURLSearchParams(input string) [][2]string {
	var pairs [][2]string
	for _, sequence := range strings.Split(input, "&") {
		if sequence == "" {
			continue
		}
		name, value, _ := strings.Cut(sequence, "=")
		decode := func(s string) string {
			s = strings.ReplaceAll(s, "+", " ")
			return strings.ToValidUTF8(percentDecode(s), "�")
		}
		pairs = append(pairs, [2]string{decode(name), decode(value)})
	}
	return pairs
}
