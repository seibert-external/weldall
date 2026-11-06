package weldall

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
)

// DirectSigningKey is a resource's own ES256 signing key, supplied by the
// service (for example from a secret manager) and stable per stage.
type DirectSigningKey struct {
	Kid     string
	Private PrivateJWK
	Public  JWK
}

// SigningHeader is the protected header a provider must sign under.
type SigningHeader struct {
	Alg string
	Kid string
	Typ string
}

// ProviderSigningKey is the active key of a SigningKeyProvider.
type ProviderSigningKey struct {
	Kid       string
	PublicJWK JWK
	// Sign returns a compact JWS of payload under header. The SDK verifies
	// the result before using it.
	Sign func(ctx context.Context, payload map[string]any, header SigningHeader) (string, error)
}

// SigningKeyProvider signs with a key held elsewhere, such as a KMS. Current
// returns the active key; JWKS returns every key to publish (1–20).
type SigningKeyProvider interface {
	Current(ctx context.Context) (ProviderSigningKey, error)
	JWKS(ctx context.Context) ([]JWK, error)
}

func signingServerError(message string) *AuthError {
	return newAuthError("server_error", message, http.StatusInternalServerError)
}

// newDirectProvider validates a direct key and wraps it as a provider.
func newDirectProvider(key DirectSigningKey) (SigningKeyProvider, error) {
	if key.Kid == "" {
		return nil, configError("invalid direct signing key")
	}
	public, err := ValidateES256KeyPair(key.Private, key.Public)
	if err != nil {
		return nil, configError("invalid direct ES256 signing key")
	}
	return &directProvider{kid: key.Kid, private: key.Private, public: public}, nil
}

type directProvider struct {
	kid     string
	private PrivateJWK
	public  JWK
}

func (p *directProvider) Current(context.Context) (ProviderSigningKey, error) {
	return ProviderSigningKey{
		Kid:       p.kid,
		PublicJWK: p.public,
		Sign: func(_ context.Context, payload map[string]any, header SigningHeader) (string, error) {
			return SignES256(payload, header.Kid, p.private, header.Typ)
		},
	}, nil
}

func (p *directProvider) JWKS(context.Context) ([]JWK, error) {
	return []JWK{p.public.withSigningMetadata(p.kid)}, nil
}

// validatedJWKS returns the provider's published keys tagged for ES256, or a
// server_error when the set is unusable.
func validatedJWKS(ctx context.Context, provider SigningKeyProvider) ([]JWK, error) {
	keys, err := provider.JWKS(ctx)
	if err != nil {
		return nil, signingServerError("signing provider unavailable")
	}
	invalid := signingServerError("signing provider returned an invalid JWKS")
	if len(keys) < 1 || len(keys) > 20 {
		return nil, invalid
	}
	result := make([]JWK, 0, len(keys))
	kids := map[string]bool{}
	for _, candidate := range keys {
		if candidate.Kid == "" || candidate.kidNotString || kids[candidate.Kid] || AssertPublicP256(candidate) != nil {
			return nil, invalid
		}
		kids[candidate.Kid] = true
		result = append(result, candidate.withSigningMetadata(candidate.Kid))
	}
	return result, nil
}

// signWithProvider signs payload, then re-verifies the provider's output:
// the active key must be published, the signature must verify, and the
// header and payload must be exactly what was asked for. This guards against
// a misbehaving KMS or vault signer.
func signWithProvider(ctx context.Context, provider SigningKeyProvider, payload map[string]any, typ string, now int64) (string, error) {
	key, err := provider.Current(ctx)
	if err != nil {
		return "", signingServerError("signing provider unavailable")
	}
	if key.Kid == "" || key.Sign == nil || AssertPublicP256(key.PublicJWK) != nil {
		return "", signingServerError("signing provider returned an invalid key")
	}
	published, err := validatedJWKS(ctx, provider)
	if err != nil {
		return "", err
	}
	found := false
	for _, candidate := range published {
		if candidate.Kid == key.Kid && SafeEqual(candidate.Thumbprint(), key.PublicJWK.Thumbprint()) {
			found = true
		}
	}
	if !found {
		return "", signingServerError("active signing key is not present in provider JWKS")
	}
	expected, err := normalizeJSON(payload)
	if err != nil {
		return "", signingServerError("token signing failed")
	}
	token, err := key.Sign(ctx, clonePayload(payload), SigningHeader{Alg: "ES256", Kid: key.Kid, Typ: typ})
	if err != nil {
		return "", signingServerError("token signing failed")
	}
	invalid := signingServerError("signing provider returned an invalid signature")
	publicKey, err := key.PublicJWK.minimal().publicKey()
	if err != nil {
		return "", invalid
	}
	header, raw, err := verifyCompact(token, verifyWithKey(publicKey))
	if err != nil {
		return "", invalid
	}
	verified, err := validateClaims(header, raw, claimOptions{typ: typ, now: now})
	if err != nil || header["kid"] != key.Kid || header["alg"] != "ES256" || header["typ"] != typ {
		return "", invalid
	}
	actual, err := normalizeJSON(verified)
	if err != nil || !reflect.DeepEqual(actual, expected) {
		return "", invalid
	}
	return token, nil
}

// normalizeJSON round-trips a value through JSON so that two payloads compare
// equal exactly when JavaScript's isDeepStrictEqual would call them equal.
func normalizeJSON(value any) (any, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func clonePayload(payload map[string]any) map[string]any {
	clone, _ := normalizeJSON(payload)
	m, _ := clone.(map[string]any)
	return m
}
