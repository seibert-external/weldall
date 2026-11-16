package weldall

import (
	"crypto/rand"
	"fmt"
	"net/http"
	"time"
)

func unixNow(now time.Time) int64 {
	if now.IsZero() {
		return time.Now().Unix()
	}
	return now.Unix()
}

func newJTI() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// SignES256 signs a JWT payload with ES256 under the header
// {alg: ES256, kid, typ}. An empty typ means "JWT".
func SignES256(payload map[string]any, kid string, key PrivateJWK, typ string) (string, error) {
	if typ == "" {
		typ = "JWT"
	}
	private, err := key.privateKey()
	if err != nil {
		return "", err
	}
	return signCompact(map[string]any{"alg": "ES256", "kid": kid, "typ": typ}, payload, private)
}

// VerifyES256Input configures VerifyES256.
type VerifyES256Input struct {
	Kid         string
	PublicJWK   JWK
	Issuer      string
	Audience    string
	MaxTokenAge time.Duration // zero: no age limit
	Typ         string        // empty means "JWT"
	ErrorCode   string        // empty means "invalid_grant"
	ErrorStatus int           // zero: 401 for invalid_token, else 400
	Now         time.Time
}

// VerifyES256 verifies an ES256 JWT's signature, header kid and typ, and the
// iss, aud, exp and iat claims (5 s clock tolerance). Every failure is the
// same AuthError.
func VerifyES256(token string, in VerifyES256Input) (map[string]any, error) {
	code := in.ErrorCode
	if code == "" {
		code = "invalid_grant"
	}
	status := in.ErrorStatus
	if status == 0 {
		status = http.StatusBadRequest
		if code == "invalid_token" {
			status = http.StatusUnauthorized
		}
	}
	typ := in.Typ
	if typ == "" {
		typ = "JWT"
	}
	failed := newAuthError(code, "token validation failed", status)
	key, err := in.PublicJWK.publicKey()
	if err != nil {
		return nil, failed
	}
	header, raw, err := verifyCompact(token, verifyWithKey(key))
	if err != nil {
		return nil, failed
	}
	payload, err := validateClaims(header, raw, claimOptions{
		issuer:         in.Issuer,
		audience:       in.Audience,
		requiredClaims: []string{"iss", "aud", "exp", "iat"},
		maxTokenAge:    int64(in.MaxTokenAge / time.Second),
		clockTolerance: clockToleranceSecs,
		now:            unixNow(in.Now),
	})
	if err != nil || header["kid"] != in.Kid || header["typ"] != typ {
		return nil, failed
	}
	return payload, nil
}
