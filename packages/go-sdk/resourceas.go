package weldall

import (
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"
)

// sortedScope de-duplicates and sorts scopes into a scope claim.
func sortedScope(scopes []string) string {
	seen := map[string]bool{}
	unique := []string{}
	for _, scope := range scopes {
		if !seen[scope] {
			seen[scope] = true
			unique = append(unique, scope)
		}
	}
	sort.Strings(unique)
	return strings.Join(unique, " ")
}

// IssueTokenInput configures IssueAccessToken and IssueIDJAG.
type IssueTokenInput struct {
	Issuer     string
	Subject    string
	Email      string
	Audience   string // ID-JAG only: the resource authorization server
	Resource   string
	ClientID   string
	Scopes     []string
	JKT        string
	Kid        string
	PrivateJWK PrivateJWK
	Now        time.Time
}

func (in IssueTokenInput) validate(kind string) (string, error) {
	scope := sortedScope(in.Scopes)
	_, scopeOK := ParseScope(scope)
	if in.Subject == "" || !hasVerifiedEmail(map[string]any{"email": in.Email, "email_verified": true}) ||
		!IsSHA256JWKThumbprint(in.JKT) || !scopeOK {
		return "", errors.New("invalid " + kind + " issuance claims")
	}
	return scope, nil
}

// IssueAccessToken issues a 10-minute DPoP-bound at+jwt access token.
func IssueAccessToken(in IssueTokenInput) (string, error) {
	scope, err := in.validate("access-token")
	if err != nil {
		return "", err
	}
	now := unixNow(in.Now)
	return SignES256(map[string]any{
		"iss":            in.Issuer,
		"sub":            in.Subject,
		"email":          in.Email,
		"email_verified": true,
		"aud":            in.Resource,
		"client_id":      in.ClientID,
		"scope":          scope,
		"cnf":            map[string]any{"jkt": in.JKT},
		"jti":            newJTI(),
		"iat":            now,
		"exp":            now + userTokenSeconds,
	}, in.Kid, in.PrivateJWK, accessTokenTyp)
}

// VerifyAccessTokenInput configures VerifyAccessToken.
type VerifyAccessTokenInput struct {
	Issuer         string
	Resource       string
	Kid            string
	PublicJWK      JWK
	ClientID       string
	RequiredScopes []string
	Now            time.Time
}

// VerifyAccessToken verifies an at+jwt access token issued by
// IssueAccessToken (or a compatible issuer) against one known key.
func VerifyAccessToken(token string, in VerifyAccessTokenInput) (map[string]any, error) {
	p, err := VerifyES256(token, VerifyES256Input{
		Kid:         in.Kid,
		PublicJWK:   in.PublicJWK,
		Issuer:      in.Issuer,
		Audience:    in.Resource,
		MaxTokenAge: 10 * time.Minute,
		Typ:         accessTokenTyp,
		ErrorCode:   "invalid_token",
		ErrorStatus: http.StatusUnauthorized,
		Now:         in.Now,
	})
	if err != nil {
		return nil, err
	}
	granted, scopeOK := ParseScope(p["scope"])
	if p["aud"] != in.Resource || !validCnf(p["cnf"]) || !nonEmptyString(p["sub"]) || !hasVerifiedEmail(p) ||
		p["client_id"] != in.ClientID || !validLifetime(p, userTokenSeconds) || !scopeOK {
		return nil, newAuthError("invalid_token", "invalid access token claims", http.StatusUnauthorized)
	}
	for _, scope := range in.RequiredScopes {
		if !contains(granted, scope) {
			err := newAuthError("insufficient_scope", "required scope is missing", http.StatusForbidden)
			err.RequiredScopes = append([]string(nil), in.RequiredScopes...)
			return nil, err
		}
	}
	return p, nil
}

func nonEmptyString(value any) bool {
	s, ok := value.(string)
	return ok && s != ""
}

// validCnf requires cnf to be an object whose jkt is a SHA-256 thumbprint.
func validCnf(value any) bool {
	cnf, ok := isRecord(value)
	return ok && IsSHA256JWKThumbprint(cnf["jkt"])
}

func cnfJKT(claims map[string]any) string {
	cnf, _ := isRecord(claims["cnf"])
	jkt, _ := cnf["jkt"].(string)
	return jkt
}

// validLifetime checks jti (1–128 characters), integer iat and exp, exp
// after iat, and a lifetime of at most maxSeconds.
func validLifetime(claims map[string]any, maxSeconds int64) bool {
	_, jtiOK := validJTI(claims["jti"])
	iat, iatOK := jsInteger(claims["iat"])
	exp, expOK := jsInteger(claims["exp"])
	return jtiOK && iatOK && expOK && exp > iat && exp-iat <= maxSeconds
}
