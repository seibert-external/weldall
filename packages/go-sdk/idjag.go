package weldall

import (
	"time"
)

// IssueIDJAG issues a 5-minute ID-JAG (identity assertion authorization
// grant), the assertion Weldall presents to a resource's token endpoint.
// Resources only verify ID-JAGs; issuing one is for tests and tooling.
func IssueIDJAG(in IssueTokenInput) (string, error) {
	scope, err := in.validate("ID-JAG")
	if err != nil {
		return "", err
	}
	now := unixNow(in.Now)
	return SignES256(map[string]any{
		"iss":            in.Issuer,
		"sub":            in.Subject,
		"email":          in.Email,
		"email_verified": true,
		"aud":            in.Audience,
		"client_id":      in.ClientID,
		"resource":       in.Resource,
		"scope":          scope,
		"cnf":            map[string]any{"jkt": in.JKT},
		"jti":            newJTI(),
		"iat":            now,
		"exp":            now + idJAGSeconds,
		idJAGDraftClaim:  IDJAGDraft,
	}, in.Kid, in.PrivateJWK, idJAGTyp)
}

// VerifyIDJAGInput configures VerifyIDJAG.
type VerifyIDJAGInput struct {
	Issuer        string
	Audience      string
	Resource      string
	ClientID      string
	Kid           string
	PublicJWK     JWK
	AllowedScopes []string
	Now           time.Time
}

// VerifyIDJAG verifies an ID-JAG against one known key and pins its
// audience, resource, client, scopes and DPoP key binding.
func VerifyIDJAG(token string, in VerifyIDJAGInput) (map[string]any, error) {
	p, err := VerifyES256(token, VerifyES256Input{
		Kid:         in.Kid,
		PublicJWK:   in.PublicJWK,
		Issuer:      in.Issuer,
		Audience:    in.Audience,
		MaxTokenAge: 5 * time.Minute,
		Typ:         idJAGTyp,
		Now:         in.Now,
	})
	if err != nil {
		return nil, err
	}
	scopes, scopeOK := ParseScope(p["scope"])
	if !idJAGClaimsValid(p, in.Audience, in.Resource, in.ClientID) || !scopeOK {
		return nil, newAuthError("invalid_grant", "invalid ID-JAG claims", 0)
	}
	for _, scope := range scopes {
		if !contains(in.AllowedScopes, scope) {
			return nil, newAuthError("invalid_scope", "", 0)
		}
	}
	return p, nil
}

func idJAGClaimsValid(p map[string]any, audience, resource, clientID string) bool {
	return p["aud"] == audience && p["resource"] == resource && p["client_id"] == clientID &&
		nonEmptyString(p["sub"]) && hasVerifiedEmail(p) && validLifetime(p, idJAGSeconds) &&
		validCnf(p["cnf"]) && p[idJAGDraftClaim] == IDJAGDraft
}
