package weldall

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"strings"
	"unicode/utf8"
)

// This file is the JOSE layer: compact ES256 JWS and the JWT claim checks the
// TypeScript SDK gets from `jose` (jwtVerify). Protocol-level claim rules are
// layered on top by the callers, exactly as in the TypeScript SDK.

var errInvalidJWS = errors.New("invalid JWS")

// signCompact signs payload with ES256 under the given protected header.
func signCompact(header map[string]any, payload any, key *ecdsa.PrivateKey) (string, error) {
	headerJSON, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	signingInput := base64.RawURLEncoding.EncodeToString(headerJSON) + "." +
		base64.RawURLEncoding.EncodeToString(payloadJSON)
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		return "", err
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

// decodeBase64URL accepts base64url with or without padding.
func decodeBase64URL(value string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(value, "="))
}

// decodeJSONObject strictly decodes UTF-8 JSON into an object, keeping
// numbers as json.Number.
func decodeJSONObject(data []byte) (map[string]any, error) {
	if !utf8.Valid(data) {
		return nil, errInvalidJWS
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, errInvalidJWS
	}
	if decoder.More() {
		return nil, errInvalidJWS
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, errInvalidJWS
	}
	return object, nil
}

// decodeProtectedHeader mirrors jose's decodeProtectedHeader: the first
// segment of a three-part token, as a JSON object. Nothing is verified.
func decodeProtectedHeader(token string) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if (len(parts) != 3 && len(parts) != 5) || parts[0] == "" {
		return nil, errInvalidJWS
	}
	raw, err := decodeBase64URL(parts[0])
	if err != nil {
		return nil, errInvalidJWS
	}
	return decodeJSONObject(raw)
}

// decodePayload decodes the payload segment without verifying it.
func decodePayload(token string) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errInvalidJWS
	}
	raw, err := decodeBase64URL(parts[1])
	if err != nil {
		return nil, errInvalidJWS
	}
	return decodeJSONObject(raw)
}

// keyResolver returns the verification key for a protected header.
type keyResolver func(header map[string]any) (*ecdsa.PublicKey, error)

// verifyCompact verifies an ES256 compact JWS the way jose's compactVerify
// does with algorithms ["ES256"], returning the protected header and the raw
// payload bytes.
func verifyCompact(token string, resolve keyResolver) (map[string]any, []byte, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, nil, errInvalidJWS
	}
	rawHeader, err := decodeBase64URL(parts[0])
	if err != nil {
		return nil, nil, errInvalidJWS
	}
	header, err := decodeJSONObject(rawHeader)
	if err != nil {
		return nil, nil, err
	}
	if err := validateCrit(header); err != nil {
		return nil, nil, err
	}
	if alg, _ := header["alg"].(string); alg != "ES256" {
		return nil, nil, errInvalidJWS
	}
	key, err := resolve(header)
	if err != nil {
		return nil, nil, err
	}
	signature, err := decodeBase64URL(parts[2])
	if err != nil || len(signature) != 64 {
		return nil, nil, errInvalidJWS
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r := new(big.Int).SetBytes(signature[:32])
	s := new(big.Int).SetBytes(signature[32:])
	if !ecdsa.Verify(key, digest[:], r, s) {
		return nil, nil, errInvalidJWS
	}
	payload, err := decodeBase64URL(parts[1])
	if err != nil {
		return nil, nil, errInvalidJWS
	}
	return header, payload, nil
}

// validateCrit applies jose's crit rules: the only recognised extension is
// b64, and a JWT must not use an unencoded payload.
func validateCrit(header map[string]any) error {
	crit, present := header["crit"]
	if !present {
		return nil
	}
	list, ok := crit.([]any)
	if !ok || len(list) == 0 {
		return errInvalidJWS
	}
	seen := map[string]bool{}
	for _, entry := range list {
		name, ok := entry.(string)
		if !ok || name == "" || seen[name] || name != "b64" {
			return errInvalidJWS
		}
		seen[name] = true
	}
	b64, ok := header["b64"].(bool)
	if !ok || !b64 {
		return errInvalidJWS
	}
	return nil
}

func verifyWithKey(key *ecdsa.PublicKey) keyResolver {
	return func(map[string]any) (*ecdsa.PublicKey, error) { return key, nil }
}

// claimOptions mirrors the jwtVerify options the SDK uses.
type claimOptions struct {
	typ            string
	issuer         string
	subject        string
	audience       string
	requiredClaims []string
	maxTokenAge    int64 // seconds; 0 means unset
	clockTolerance int64
	now            int64
}

// validateClaims mirrors jose's validateClaimsSet for the options above.
func validateClaims(header map[string]any, rawPayload []byte, o claimOptions) (map[string]any, error) {
	payload, err := decodeJSONObject(rawPayload)
	if err != nil {
		return nil, err
	}
	fail := errors.New("JWT claim validation failed")
	if o.typ != "" {
		typ, ok := header["typ"].(string)
		if !ok || normalizeTyp(typ) != normalizeTyp(o.typ) {
			return nil, fail
		}
	}
	required := append([]string(nil), o.requiredClaims...)
	if o.maxTokenAge != 0 {
		required = append(required, "iat")
	}
	if o.audience != "" {
		required = append(required, "aud")
	}
	if o.subject != "" {
		required = append(required, "sub")
	}
	if o.issuer != "" {
		required = append(required, "iss")
	}
	for _, claim := range required {
		if _, ok := payload[claim]; !ok {
			return nil, fail
		}
	}
	if o.issuer != "" && payload["iss"] != o.issuer {
		return nil, fail
	}
	if o.subject != "" && payload["sub"] != o.subject {
		return nil, fail
	}
	if o.audience != "" && !audienceContains(payload["aud"], o.audience) {
		return nil, fail
	}
	numericDate := func(claim string, required bool) (float64, bool, error) {
		value, present := payload[claim]
		if !present && !required {
			return 0, false, nil
		}
		n, ok := jsNumber(value)
		if !ok {
			return 0, false, fail
		}
		return n, true, nil
	}
	now, tolerance := float64(o.now), float64(o.clockTolerance)
	iat, _, err := numericDate("iat", o.maxTokenAge != 0)
	if err != nil {
		return nil, err
	}
	if nbf, present, err := numericDate("nbf", false); err != nil {
		return nil, err
	} else if present && nbf > now+tolerance {
		return nil, fail
	}
	if exp, present, err := numericDate("exp", false); err != nil {
		return nil, err
	} else if present && exp <= now-tolerance {
		return nil, fail
	}
	if o.maxTokenAge != 0 {
		age := now - iat
		if age-tolerance > float64(o.maxTokenAge) || age < -tolerance {
			return nil, fail
		}
	}
	return payload, nil
}

func normalizeTyp(value string) string {
	normalized := strings.ToLower(value)
	if strings.Contains(value, "/") {
		return normalized
	}
	return "application/" + normalized
}

func audienceContains(aud any, audience string) bool {
	switch v := aud.(type) {
	case string:
		return v == audience
	case []any:
		for _, entry := range v {
			if entry == audience {
				return true
			}
		}
	}
	return false
}
