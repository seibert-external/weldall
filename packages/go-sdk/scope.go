package weldall

import (
	"regexp"
	"strings"
)

var (
	scopeToken   = regexp.MustCompile(`^[\x21\x23-\x5b\x5d-\x7e]+$`)
	emailPattern = regexp.MustCompile(`^[^@` + jsWhitespaceClass + `]+@[^@` + jsWhitespaceClass + `]+$`)
)

// ParseScope splits an OAuth scope claim. It returns false when the value is
// not a non-empty string of unique, valid scope tokens separated by single
// spaces.
func ParseScope(value any) ([]string, bool) {
	s, ok := value.(string)
	if !ok || s == "" {
		return nil, false
	}
	scopes := strings.Split(s, " ")
	seen := make(map[string]bool, len(scopes))
	for _, scope := range scopes {
		if !scopeToken.MatchString(scope) || seen[scope] {
			return nil, false
		}
		seen[scope] = true
	}
	return scopes, true
}

func uniqueScopes(values []string, label string) ([]string, error) {
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		if !scopeToken.MatchString(value) || seen[value] {
			return nil, configError(label + " must contain unique valid OAuth scope tokens")
		}
		seen[value] = true
	}
	return append([]string(nil), values...), nil
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

// hasVerifiedEmail mirrors identity.ts: a trimmed, plausible address of at
// most 320 characters with email_verified exactly true.
func hasVerifiedEmail(claims map[string]any) bool {
	email, ok := claims["email"].(string)
	if !ok || utf16Length(email) > 320 || email != strings.TrimFunc(email, isJSWhitespace) ||
		!emailPattern.MatchString(email) {
		return false
	}
	verified, ok := claims["email_verified"].(bool)
	return ok && verified
}
