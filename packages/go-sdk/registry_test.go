package weldall

import (
	"strings"
	"testing"
)

// Port of packages/sdk/test/resource-registry.test.ts.

func TestRequestPrefixAcceptsSegmentWise(t *testing.T) {
	for target, want := range map[string]bool{
		"https://example.com/api":                  true,
		"https://example.com/api/events":           true,
		"https://example.com/api/events?year=2026": true,
		"https://example.com/api-attacker":         false,
		"https://other.example.com/api/events":     false,
		"https://example.com/other/../api/events":  true,
		"https://example.com:443/api/events":       true,
	} {
		got, err := RequestPrefixAccepts("https://example.com/api", target)
		if err != nil || got != want {
			t.Errorf("%s: %v %v, want %v", target, got, err, want)
		}
	}
}

func TestRegistryNormalisationIsIdempotent(t *testing.T) {
	if got, _ := NormalizeAuthorizationServer("https://EXAMPLE.com:443"); got != "https://example.com" {
		t.Errorf("authorization server %q", got)
	}
	for _, input := range []string{"https://EXAMPLE.com:443/api/", "https://EXAMPLE.com:443/api//", "https://EXAMPLE.com:443/api///"} {
		normalized, err := NormalizeRequestPrefix(input)
		again, _ := NormalizeRequestPrefix(normalized)
		if err != nil || normalized != "https://example.com/api" || again != normalized {
			t.Errorf("%s: %q %q %v", input, normalized, again, err)
		}
	}
	if got, _ := NormalizeRequestPrefix("https://example.com///"); got != "https://example.com/" {
		t.Errorf("root prefix %q", got)
	}
	if got, _ := NormalizeRequestTarget("https://EXAMPLE.com/api?q=1"); got != "https://example.com/api?q=1" {
		t.Errorf("target %q", got)
	}
}

func TestOverlapAndResolution(t *testing.T) {
	if ok, _ := RequestPrefixesOverlap("https://example.com/api", "https://example.com/api/events"); !ok {
		t.Error("nested prefixes must overlap")
	}
	if ok, _ := RequestPrefixesOverlap("https://example.com/api", "https://example.com/api-v2"); ok {
		t.Error("sibling prefixes must not overlap")
	}
	type entry struct {
		key      string
		prefixes []string
	}
	resources := []entry{
		{"one", []string{"https://example.com/api", "https://example.com/api/events"}},
		{"two", []string{"https://other.example.com/api"}},
	}
	got, err := ResolveResourceForTarget(resources, func(e entry) []string { return e.prefixes }, "https://example.com/api/events/1")
	if err != nil || len(got) != 1 || got[0].key != "one" {
		t.Fatalf("resolved %v %v", got, err)
	}
}

func TestRejectsUnsafePrefixesAndTargets(t *testing.T) {
	for _, prefix := range []string{
		"http://example.com/api", "https://user@example.com/api", "https://example.com/api?x=1",
		"https://example.com/api#fragment", "https://example.com/%61pi", "https://example.com/api%2Fevents",
	} {
		if _, err := NormalizeRequestPrefix(prefix); err == nil {
			t.Errorf("accepted prefix %s", prefix)
		}
	}
	for _, target := range []string{
		"https://example.com/api/..%2Fadmin", "https://example.com/api/%2e%2e%2fadmin",
		"https://example.com/api/%5Cadmin", "https://example.com/api%2Fevents",
	} {
		if _, err := NormalizeRequestTarget(target); err == nil || !strings.Contains(err.Error(), "percent encoding") {
			t.Errorf("target %s: %v", target, err)
		}
		if _, err := RequestPrefixAccepts("https://example.com/api", target); err == nil || !strings.Contains(err.Error(), "percent encoding") {
			t.Errorf("accepts %s: %v", target, err)
		}
	}
}
