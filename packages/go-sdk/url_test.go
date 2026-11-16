package weldall

import (
	"strings"
	"testing"
)

// urlVectors exercise the WHATWG behaviours the protocol depends on. Each is
// checked against Node's own parser, so a disagreement is a bug here.
var urlVectors = []string{
	"https://example.com",
	"https://example.com/",
	"https://EXAMPLE.com:443/a",
	"http://localhost:80/a",
	"https://example.com:8443/a?b=c#d",
	"https://INTEROP.example:443/api/a//../items?ignored=yes",
	"https:faß.de/a[b|c]?ignored=yes",
	"http://127.1/a",
	"https://[::ffff:127.0.0.1]/a",
	"https://[0:0:0:0:0:0:0:1]/",
	"https://[2001:db8:0:0:1:0:0:1]/",
	"https://[2001:DB8::1]:443/",
	"https://a..com/a",
	"https://example.com/a%5Bb%7Cc%5D",
	"https://example.com/a/./b/../c",
	"https://example.com/a/%2e/b/%2E%2e/c",
	"https://example.com/a/..",
	"https://example.com/a/.",
	"https://example.com/../../a",
	"https:\\\\example.com\\a\\b",
	"https:///example.com/a",
	"  https://example.com/a  ",
	"https://exa\tmple.com/a\nb",
	"https://user:pass@example.com/",
	"https://user@example.com/",
	"https://@example.com/",
	"https://a@b@example.com/",
	"https://example.com/ a\"<>`{}^|",
	"https://example.com/?q= \"'<>#frag ment`",
	"https://example.com/ünï",
	"https://ÉXAMPLE.com/",
	"https://xn--fa-hia.de/",
	"https://0x7f.1/",
	"https://0177.0.0.1/",
	"https://4294967295/",
	"https://4294967296/",
	"https://256.0.0.1/",
	"https://1.2.3.4.5/",
	"https://example.com:65535/",
	"https://example.com:65536/",
	"https://example.com:0443/",
	"https://example.com:/a",
	"https://example.com:x/",
	"https://exa mple.com/",
	"https://exa%20mple.com/",
	"https://exa%41mple.com/",
	"https://[::1%25eth0]/",
	"https://[::1/",
	"https://",
	"https://?a",
	"ftp://example.com/",
	"example.com/a",
	"HTTPS://Example.COM/A",
	"https://example.com?",
	"https://example.com#",
	"https://example.com/a?b#",
	"https://example.com/%zz",
	"https://ex%zzample.com/",
	"https://example.com./",
	"https://xn--/",
	"https://a.b.c.0x/",
	"https://example\u3002com/",
	"https://ex\u00ADample.com/",
	"https://\uFF05\uFF14\uFF11.com/",
	"https://XN--fa-hia.de/",
	"https://xn--fa-hia.DE./a",
	"https://\u0645\u062B\u0627\u0644.com/",
	"https://a\u200Db.com/",
	"https://example.com:443:443/",
	"http://[::1]:80/a",
	"http://127.0.0.1/a",
	"http://LOCALHOST/a",
	"http://example.com/a",
}

// knownDeviations are inputs where this parser deliberately fails closed
// while Node's parser accepts.
var knownDeviations = map[string]string{
	// x/net/idna rejects an empty punycode label; Node keeps "xn--".
	"https://xn--/": "empty punycode label",
}

func TestURLSerializationMatchesNode(t *testing.T) {
	var want struct {
		URLs []*string `json:"urls"`
	}
	node(t, "href", map[string]any{"urls": urlVectors}, &want)
	for i, input := range urlVectors {
		u, err := parseURL(input)
		got := (*string)(nil)
		if err == nil {
			s := u.String()
			got = &s
		}
		if want.URLs[i] != nil && !strings.HasPrefix(*want.URLs[i], "http") {
			continue // the parser only supports http and https
		}
		if _, deviation := knownDeviations[input]; deviation && got == nil {
			continue
		}
		if !equalOptional(got, want.URLs[i]) {
			t.Errorf("parseURL(%q) = %s, Node = %s", input, show(got), show(want.URLs[i]))
		}
	}
}

func TestNormalizeHTUMatchesNode(t *testing.T) {
	var want struct {
		URLs []*string `json:"urls"`
	}
	node(t, "normalize", map[string]any{"urls": urlVectors}, &want)
	for i, input := range urlVectors {
		got := (*string)(nil)
		if s, err := NormalizeHTU(input); err == nil {
			got = &s
		}
		if _, deviation := knownDeviations[input]; deviation && got == nil {
			continue
		}
		if !equalOptional(got, want.URLs[i]) {
			t.Errorf("NormalizeHTU(%q) = %s, Node = %s", input, show(got), show(want.URLs[i]))
		}
	}
}

func equalOptional(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func show(s *string) string {
	if s == nil {
		return "<error>"
	}
	return "\"" + *s + "\""
}
