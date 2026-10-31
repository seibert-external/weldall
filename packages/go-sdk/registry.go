package weldall

import (
	"strings"
)

// Resource registry helpers, ported from packages/sdk/src/resource-registry.ts:
// the URL contract that maps a request URL to the registered resource whose
// request prefix accepts it.

func parseHTTPSURL(value, label string) (*parsedURL, error) {
	u, err := parseURL(value)
	if err != nil {
		return nil, configError(label + " must be an absolute HTTPS URL")
	}
	if u.scheme != "https" || u.hasCredentials() {
		return nil, configError(label + " must be HTTPS and must not contain credentials")
	}
	return u, nil
}

func trimJS(value string) string { return strings.TrimFunc(value, isJSWhitespace) }

// NormalizeResourceIdentifier returns the WHATWG serialization of an HTTPS
// resource identifier without credentials or fragment.
func NormalizeResourceIdentifier(value string) (string, error) {
	u, err := parseHTTPSURL(trimJS(value), "Resource identifier")
	if err != nil {
		return "", err
	}
	if u.hash() != "" {
		return "", configError("Resource identifier must not contain a fragment")
	}
	return u.String(), nil
}

// NormalizeAuthorizationServer returns the origin of an HTTPS authorization
// server given without path, query or fragment.
func NormalizeAuthorizationServer(value string) (string, error) {
	u, err := parseHTTPSURL(trimJS(value), "Authorization server")
	if err != nil {
		return "", err
	}
	if u.path != "/" || u.search() != "" || u.hash() != "" {
		return "", configError("Authorization server must be an HTTPS origin without path, query, or fragment")
	}
	return u.origin(), nil
}

// NormalizeRequestPrefix returns a canonical request prefix: HTTPS, no
// query, fragment or percent-encoded path, trailing slashes removed.
func NormalizeRequestPrefix(value string) (string, error) {
	u, err := parseHTTPSURL(trimJS(value), "Request prefix")
	if err != nil {
		return "", err
	}
	if u.search() != "" || u.hash() != "" {
		return "", configError("Request prefix must not contain a query or fragment")
	}
	if strings.Contains(u.path, "%") {
		return "", configError("Request prefix paths must not contain percent encoding")
	}
	if len(u.path) > 1 {
		u.path = strings.TrimRight(u.path, "/")
		if u.path == "" {
			u.path = "/"
		}
	}
	return u.String(), nil
}

// NormalizeRequestTarget validates a request URL: HTTPS, no credentials,
// fragment or percent-encoded path.
func NormalizeRequestTarget(value string) (string, error) {
	u, err := normalizeRequestTarget(value)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func normalizeRequestTarget(value string) (*parsedURL, error) {
	u, err := parseHTTPSURL(value, "Request URL")
	if err != nil {
		return nil, err
	}
	if u.hash() != "" {
		return nil, configError("Request URL must not contain a fragment")
	}
	if strings.Contains(u.path, "%") {
		return nil, configError("Request URL paths must not contain percent encoding")
	}
	return u, nil
}

// RequestPrefixAccepts reports whether target falls under prefix: same
// origin, and the path equal to the prefix path or below it segment-wise.
func RequestPrefixAccepts(prefix, target string) (bool, error) {
	normalized, err := NormalizeRequestPrefix(prefix)
	if err != nil {
		return false, err
	}
	p, err := parseURL(normalized)
	if err != nil {
		return false, err
	}
	t, err := normalizeRequestTarget(target)
	if err != nil {
		return false, err
	}
	if p.origin() != t.origin() {
		return false, nil
	}
	return p.path == "/" || t.path == p.path || strings.HasPrefix(t.path, p.path+"/"), nil
}

// RequestPrefixesOverlap reports whether either prefix accepts the other.
func RequestPrefixesOverlap(left, right string) (bool, error) {
	l, err := NormalizeRequestPrefix(left)
	if err != nil {
		return false, err
	}
	r, err := NormalizeRequestPrefix(right)
	if err != nil {
		return false, err
	}
	if ok, err := RequestPrefixAccepts(l, r); err != nil || ok {
		return ok, err
	}
	return RequestPrefixAccepts(r, l)
}

// ResolveResourceForTarget returns the resources with a request prefix that
// accepts target.
func ResolveResourceForTarget[T any](resources []T, prefixes func(T) []string, target string) ([]T, error) {
	var matches []T
	for _, resource := range resources {
		for _, prefix := range prefixes(resource) {
			ok, err := RequestPrefixAccepts(prefix, target)
			if err != nil {
				return nil, err
			}
			if ok {
				matches = append(matches, resource)
				break
			}
		}
	}
	return matches, nil
}
