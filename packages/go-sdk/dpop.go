package weldall

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// NormalizeHTU canonicalises a DPoP htu value: https only (http for loopback
// hosts), no credentials, query and fragment dropped, default port removed.
func NormalizeHTU(input string) (string, error) {
	u, err := parseURL(input)
	if err != nil {
		return "", newAuthError("invalid_dpop_proof", "invalid htu", 0)
	}
	if u.scheme != "https" && !(u.scheme == "http" && u.isLoopback()) {
		return "", newAuthError("invalid_dpop_proof", "invalid htu scheme", 0)
	}
	if u.hasCredentials() {
		return "", newAuthError("invalid_dpop_proof", "htu must not contain credentials", 0)
	}
	return u.origin() + u.path, nil
}

// DPoPProofInput configures CreateDPoPProof.
type DPoPProofInput struct {
	Key         KeyPair
	Method      string
	URL         string
	AccessToken string // binds the proof to a token via ath when set
	Now         time.Time
	JTI         string
}

// CreateDPoPProof creates an RFC 9449 DPoP proof JWT.
func CreateDPoPProof(in DPoPProofInput) (string, error) {
	htu, err := NormalizeHTU(in.URL)
	if err != nil {
		return "", err
	}
	private, err := in.Key.Private.privateKey()
	if err != nil {
		return "", err
	}
	jti := in.JTI
	if jti == "" {
		jti = newJTI()
	}
	payload := map[string]any{
		"htm": strings.ToUpper(in.Method),
		"htu": htu,
		"iat": unixNow(in.Now),
		"jti": jti,
	}
	if in.AccessToken != "" {
		payload["ath"] = Base64URLSHA256(in.AccessToken)
	}
	header := map[string]any{"typ": dpopTyp, "alg": "ES256", "jwk": in.Key.Public}
	return signCompact(header, payload, private)
}

// VerifyDPoPInput configures VerifyStrictDPoP.
type VerifyDPoPInput struct {
	Method      string
	URL         string
	Replay      ReplayStore
	AccessToken string // when set, ath must match; when empty, ath must be absent
	ExpectedJKT string // when set, the proof key must have this thumbprint
	Now         time.Time
}

// VerifiedDPoP is a DPoP proof that passed VerifyStrictDPoP.
type VerifiedDPoP struct {
	Payload   map[string]any
	PublicJWK JWK
	JKT       string
}

// VerifyStrictDPoP verifies a DPoP proof: header, embedded public key,
// signature, htm/htu/iat/jti, key thumbprint, ath binding, then replay — in
// that order, as the TypeScript SDK does. Every failure is invalid_dpop_proof.
func VerifyStrictDPoP(ctx context.Context, proof string, in VerifyDPoPInput) (*VerifiedDPoP, error) {
	header, err := decodeProtectedHeader(proof)
	if err != nil {
		return nil, newAuthError("invalid_dpop_proof", "invalid DPoP header", 0)
	}
	rawJWK, hasJWK := header["jwk"]
	_, hasCrit := header["crit"]
	if header["typ"] != dpopTyp || header["alg"] != "ES256" || hasCrit && jsTruthy(header["crit"]) ||
		!hasJWK || !jsTruthy(rawJWK) {
		return nil, newAuthError("invalid_dpop_proof", "invalid DPoP header", 0)
	}
	var proofJWK JWK
	encoded, _ := json.Marshal(rawJWK)
	if err := json.Unmarshal(encoded, &proofJWK); err != nil || AssertPublicP256(proofJWK) != nil {
		return nil, newAuthError("invalid_dpop_proof", "invalid DPoP header", 0)
	}
	key, _ := proofJWK.minimal().publicKey()
	verifiedHeader, raw, err := verifyCompact(proof, verifyWithKey(key))
	var payload map[string]any
	if err == nil {
		payload, err = validateClaims(verifiedHeader, raw, claimOptions{typ: dpopTyp, now: unixNow(in.Now)})
	}
	if err != nil {
		return nil, newAuthError("invalid_dpop_proof", "invalid DPoP signature", 0)
	}
	now := unixNow(in.Now)
	invalidClaims := newAuthError("invalid_dpop_proof", "invalid DPoP claims", 0)
	htm, ok := payload["htm"].(string)
	if !ok || htm != strings.ToUpper(in.Method) {
		return nil, invalidClaims
	}
	htu, ok := payload["htu"].(string)
	if !ok {
		return nil, invalidClaims
	}
	proofURL, err := parseURL(htu)
	if err != nil {
		return nil, newAuthError("invalid_dpop_proof", "invalid DPoP htu", 0)
	}
	if proofURL.search() != "" || proofURL.hash() != "" {
		return nil, invalidClaims
	}
	proofHTU, err := NormalizeHTU(proofURL.String())
	if err != nil {
		return nil, err
	}
	requestHTU, err := NormalizeHTU(in.URL)
	if err != nil {
		return nil, err
	}
	iat, isInt := jsInteger(payload["iat"])
	jti, validJti := validJTI(payload["jti"])
	if proofHTU != requestHTU || !isInt || iat < now-DPoPMaxAgeSeconds || iat > now+DPoPFutureSkewSecs || !validJti {
		return nil, invalidClaims
	}
	jkt := proofJWK.Thumbprint()
	if in.ExpectedJKT != "" && !SafeEqual(jkt, in.ExpectedJKT) {
		return nil, newAuthError("invalid_dpop_proof", "DPoP key mismatch", 0)
	}
	ath, hasATH := payload["ath"]
	if in.AccessToken != "" {
		s, ok := ath.(string)
		if !ok || !SafeEqual(s, Base64URLSHA256(in.AccessToken)) {
			return nil, newAuthError("invalid_dpop_proof", "access token hash mismatch", 0)
		}
	} else if hasATH {
		return nil, newAuthError("invalid_dpop_proof", "ath is not allowed at this endpoint", 0)
	}
	if err := consumeReplay(ctx, in.Replay, "dpop", jkt+":"+jti,
		time.Unix(iat+DPoPMaxAgeSeconds+1, 0),
		newAuthError("invalid_dpop_proof", "proof was already used", 0)); err != nil {
		return nil, err
	}
	return &VerifiedDPoP{Payload: payload, PublicJWK: proofJWK, JKT: jkt}, nil
}

// jsTruthy mirrors JavaScript truthiness for decoded JSON values.
func jsTruthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case json.Number:
		f, ok := jsNumber(v)
		return ok && f != 0
	}
	return true
}
