package weldall

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
)

// JWK is a public JSON Web Key. The SDK only accepts EC P-256 keys for ES256.
//
// A JWK decoded from JSON remembers whether it carried members a strict
// public P-256 key must not have (an unknown member, a private "d", a
// mistyped member); AssertPublicP256 rejects such a key.
type JWK struct {
	Kty    string   `json:"kty,omitempty"`
	Crv    string   `json:"crv,omitempty"`
	X      string   `json:"x,omitempty"`
	Y      string   `json:"y,omitempty"`
	Kid    string   `json:"kid,omitempty"`
	Alg    string   `json:"alg,omitempty"`
	Use    string   `json:"use,omitempty"`
	KeyOps []string `json:"key_ops,omitempty"`

	strictViolation bool // set by UnmarshalJSON
	kidNotString    bool // "kid" present but not a string
	algPresent      bool
	usePresent      bool
	keyOpsPresent   bool
}

// UnmarshalJSON decodes a JWK and records the strictness facts that the
// TypeScript SDK reads from the raw object.
func (k *JWK) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if raw == nil {
		return errors.New("JWK must be a JSON object")
	}
	*k = JWK{}
	str := func(name string, target *string) (present bool) {
		value, ok := raw[name]
		if !ok {
			return false
		}
		if err := json.Unmarshal(value, target); err != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			k.strictViolation = true
		}
		return true
	}
	for name, value := range raw {
		switch name {
		case "kty", "crv", "x", "y", "alg", "use", "kid", "key_ops":
		case "d":
			// A falsy JavaScript value ("", 0, false, null) is tolerated.
			switch string(bytes.TrimSpace(value)) {
			case `""`, "0", "false", "null":
			default:
				k.strictViolation = true
			}
		default:
			k.strictViolation = true
		}
	}
	str("kty", &k.Kty)
	str("crv", &k.Crv)
	str("x", &k.X)
	str("y", &k.Y)
	k.algPresent = str("alg", &k.Alg)
	k.usePresent = str("use", &k.Use)
	if value, ok := raw["kid"]; ok {
		if err := json.Unmarshal(value, &k.Kid); err != nil || k.Kid == "" && string(value) != `""` {
			k.Kid, k.kidNotString = "", true
		}
	}
	if value, ok := raw["key_ops"]; ok {
		k.keyOpsPresent = true
		if err := json.Unmarshal(value, &k.KeyOps); err != nil || k.KeyOps == nil {
			k.strictViolation = true
		}
	}
	return nil
}

// Thumbprint returns the RFC 7638 SHA-256 JWK thumbprint, base64url encoded.
func (k JWK) Thumbprint() string {
	canonical, _ := json.Marshal(struct {
		Crv string `json:"crv"`
		Kty string `json:"kty"`
		X   string `json:"x"`
		Y   string `json:"y"`
	}{k.Crv, k.Kty, k.X, k.Y})
	sum := sha256.Sum256(canonical)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// minimal returns only the key material members.
func (k JWK) minimal() JWK { return JWK{Kty: k.Kty, Crv: k.Crv, X: k.X, Y: k.Y} }

// withSigningMetadata tags a published key as an ES256 signature key.
func (k JWK) withSigningMetadata(kid string) JWK {
	k.Kid, k.Alg, k.Use = kid, "ES256", "sig"
	k.algPresent, k.usePresent = true, true
	return k
}

func (k JWK) publicKey() (*ecdsa.PublicKey, error) {
	if k.Kty != "EC" || k.Crv != "P-256" {
		return nil, errors.New("invalid P-256 JWK")
	}
	x, errX := decodeCoordinate(k.X)
	y, errY := decodeCoordinate(k.Y)
	if errX != nil || errY != nil {
		return nil, errors.New("invalid P-256 JWK coordinates")
	}
	point := append(append([]byte{4}, x...), y...)
	return ecdsa.ParseUncompressedPublicKey(elliptic.P256(), point)
}

func decodeCoordinate(value string) ([]byte, error) {
	b, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(b) != 32 {
		return nil, errors.New("invalid coordinate")
	}
	return b, nil
}

// AssertPublicP256 accepts exactly a public EC P-256 signature key: kty, crv,
// x and y, optionally kid, alg "ES256", use "sig" and key_ops ["verify"], and
// nothing else. The point must lie on the curve.
func AssertPublicP256(k JWK) error {
	invalid := errors.New("invalid public P-256 JWK")
	if k.strictViolation || k.Kty != "EC" || k.Crv != "P-256" || k.X == "" || k.Y == "" ||
		(k.algPresent || k.Alg != "") && k.Alg != "ES256" ||
		(k.usePresent || k.Use != "") && k.Use != "sig" ||
		(k.keyOpsPresent || k.KeyOps != nil) && (len(k.KeyOps) != 1 || k.KeyOps[0] != "verify") {
		return invalid
	}
	if _, err := k.minimal().publicKey(); err != nil {
		return invalid
	}
	return nil
}

var sha256ThumbprintPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// IsSHA256JWKThumbprint reports whether value has the shape of a base64url
// SHA-256 thumbprint.
func IsSHA256JWKThumbprint(value any) bool {
	s, ok := value.(string)
	return ok && sha256ThumbprintPattern.MatchString(s)
}

// SafeEqual compares two strings in constant time; different lengths are
// simply unequal.
func SafeEqual(a, b string) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// Base64URLSHA256 returns the unpadded base64url SHA-256 of value.
func Base64URLSHA256(value string) string {
	sum := sha256.Sum256([]byte(value))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// PrivateJWK is an EC P-256 private key. Its private scalar never appears in
// fmt output, JSON encoding or slog records; ExportJSON is the one deliberate
// way to serialize it.
type PrivateJWK struct {
	Kty string
	Crv string
	X   string
	Y   string
	D   string
}

// ParsePrivateJWK decodes a private JWK from JSON, for example from an
// environment variable holding a key stored in a secret manager.
func ParsePrivateJWK(data []byte) (PrivateJWK, error) {
	var raw struct {
		Kty, Crv, X, Y, D string
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return PrivateJWK{}, errors.New("private JWK must be a JSON object")
	}
	return PrivateJWK{Kty: raw.Kty, Crv: raw.Crv, X: raw.X, Y: raw.Y, D: raw.D}, nil
}

// ExportJSON serializes the key including its private scalar.
func (k PrivateJWK) ExportJSON() ([]byte, error) {
	return json.Marshal(struct {
		Kty string `json:"kty"`
		Crv string `json:"crv"`
		X   string `json:"x"`
		Y   string `json:"y"`
		D   string `json:"d"`
	}{k.Kty, k.Crv, k.X, k.Y, k.D})
}

// Public returns the public half of the key.
func (k PrivateJWK) Public() JWK { return JWK{Kty: k.Kty, Crv: k.Crv, X: k.X, Y: k.Y} }

func (k PrivateJWK) redacted() string {
	return fmt.Sprintf("PrivateJWK{kty:%s crv:%s x:%s y:%s d:[REDACTED]}", k.Kty, k.Crv, k.X, k.Y)
}

// Format keeps the private scalar out of every fmt verb.
func (k PrivateJWK) Format(f fmt.State, _ rune) { _, _ = f.Write([]byte(k.redacted())) }

// MarshalJSON encodes only the public members.
func (k PrivateJWK) MarshalJSON() ([]byte, error) { return json.Marshal(k.Public()) }

// LogValue keeps the private scalar out of slog records.
func (k PrivateJWK) LogValue() slog.Value { return slog.StringValue(k.redacted()) }

// privateKey parses the key and checks that x and y belong to d.
func (k PrivateJWK) privateKey() (*ecdsa.PrivateKey, error) {
	invalid := errors.New("invalid private P-256 JWK")
	if k.Kty != "EC" || k.Crv != "P-256" || k.X == "" || k.Y == "" || k.D == "" {
		return nil, invalid
	}
	d, err := decodeCoordinate(k.D)
	if err != nil {
		return nil, invalid
	}
	key, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), d)
	if err != nil {
		return nil, invalid
	}
	derived, err := publicJWKFromKey(&key.PublicKey)
	if err != nil || !SafeEqual(derived.X, k.X) || !SafeEqual(derived.Y, k.Y) {
		return nil, invalid
	}
	return key, nil
}

func publicJWKFromKey(key *ecdsa.PublicKey) (JWK, error) {
	point, err := key.Bytes()
	if err != nil || len(point) != 65 {
		return JWK{}, errors.New("invalid P-256 public key")
	}
	return JWK{
		Kty: "EC",
		Crv: "P-256",
		X:   base64.RawURLEncoding.EncodeToString(point[1:33]),
		Y:   base64.RawURLEncoding.EncodeToString(point[33:]),
	}, nil
}

// KeyPair is an ES256 key pair with the RFC 7638 thumbprint of its public
// key — the DPoP key of a client, or a machine client's registered key.
type KeyPair struct {
	Private PrivateJWK
	Public  JWK
	JKT     string
}

// GenerateES256KeyPair creates a new random P-256 key pair. The SDK never
// calls it on its own: signing keys are always supplied by configuration.
func GenerateES256KeyPair() (KeyPair, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return KeyPair{}, err
	}
	public, err := publicJWKFromKey(&key.PublicKey)
	if err != nil {
		return KeyPair{}, err
	}
	d, err := key.Bytes()
	if err != nil {
		return KeyPair{}, err
	}
	private := PrivateJWK{Kty: "EC", Crv: "P-256", X: public.X, Y: public.Y, D: base64.RawURLEncoding.EncodeToString(d)}
	return KeyPair{Private: private, Public: public, JKT: public.Thumbprint()}, nil
}

// ValidateES256KeyPair checks that a private key and a separately configured
// public key form one P-256 key pair.
func ValidateES256KeyPair(private PrivateJWK, configuredPublic JWK) (JWK, error) {
	if _, err := private.privateKey(); err != nil {
		return JWK{}, err
	}
	if err := AssertPublicP256(configuredPublic); err != nil {
		return JWK{}, err
	}
	derived := private.Public()
	if !SafeEqual(derived.Thumbprint(), configuredPublic.Thumbprint()) {
		return JWK{}, errors.New("ES256 public/private key mismatch")
	}
	return derived, nil
}

// LoadES256KeyPairFromEnv parses a private and a public JWK from two JSON
// values (typically environment variables) and validates them as one pair.
func LoadES256KeyPairFromEnv(privateName, privateValue, publicName, publicValue string) (PrivateJWK, JWK, error) {
	if privateValue == "" {
		return PrivateJWK{}, JWK{}, configError(privateName + " is required")
	}
	if publicValue == "" {
		return PrivateJWK{}, JWK{}, configError(publicName + " is required")
	}
	private, err := ParsePrivateJWK([]byte(privateValue))
	if err != nil {
		return PrivateJWK{}, JWK{}, configError(privateName + " must be JSON")
	}
	var public JWK
	if err := json.Unmarshal([]byte(publicValue), &public); err != nil {
		return PrivateJWK{}, JWK{}, configError(publicName + " must be JSON")
	}
	derived, err := ValidateES256KeyPair(private, public)
	if err != nil {
		return PrivateJWK{}, JWK{}, err
	}
	return private, derived, nil
}
