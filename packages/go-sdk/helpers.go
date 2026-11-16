package weldall

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
)

// ConfigError reports invalid SDK configuration or arguments; the TypeScript
// SDK throws a TypeError in the same places.
type ConfigError struct{ Message string }

func (e *ConfigError) Error() string { return e.Message }

func configError(message string) error { return &ConfigError{Message: message} }

// The protocol's validation rules come from JavaScript, so string lengths are
// UTF-16 code units and "whitespace" is the ECMAScript set, not Go's.

func utf16Length(s string) int { return len(utf16.Encode([]rune(s))) }

func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f,
		0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// jsWhitespaceClass is the body of a regexp class matching ECMAScript \s.
const jsWhitespaceClass = `\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// jsInteger mirrors Number.isInteger on a decoded JSON value.
func jsInteger(value any) (int64, bool) {
	n, ok := jsNumber(value)
	if !ok || n != math.Trunc(n) || math.Abs(n) > 1<<53 {
		return 0, false
	}
	return int64(n), true
}

// jsNumber mirrors typeof value === "number" for a JSON value decoded with
// UseNumber.
func jsNumber(value any) (float64, bool) {
	switch v := value.(type) {
	case json.Number:
		// An out-of-range literal is ±Infinity in JavaScript: still a number.
		f, err := strconv.ParseFloat(string(v), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return 0, false
		}
		return f, true
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	}
	return 0, false
}

func jsString(value any) (string, bool) {
	s, ok := value.(string)
	return s, ok
}

// validJTI mirrors the 1–128 character jti rule.
func validJTI(value any) (string, bool) {
	s, ok := value.(string)
	if !ok {
		return "", false
	}
	n := utf16Length(s)
	return s, n >= 1 && n <= 128
}

// mediaType is the lower-cased type/subtype of a Content-Type value, without
// parameters, as the TypeScript SDK compares it.
func mediaType(contentType string) string {
	value, _, _ := strings.Cut(contentType, ";")
	return strings.ToLower(strings.TrimSpace(value))
}

func isRecord(value any) (map[string]any, bool) {
	m, ok := value.(map[string]any)
	return m, ok
}

// marshalJSON encodes like JSON.stringify: no HTML escaping, no newline.
func marshalJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}
