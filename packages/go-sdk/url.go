package weldall

import (
	"errors"
	"net/netip"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/idna"
)

// The protocol compares URLs by their WHATWG serialization (the TypeScript SDK
// uses `new URL()`), and Go's net/url differs from WHATWG in host handling,
// IPv4 shorthand, backslashes, dot segments and percent-encoding. This file is
// a focused WHATWG URL parser for the two schemes the protocol uses, http and
// https; interop tests compare its output with Node's.

var errInvalidURL = errors.New("invalid URL")

type parsedURL struct {
	scheme      string
	username    string
	password    string
	host        string // serialized; IPv6 includes brackets
	port        int    // -1 when absent or default
	path        string // serialized, always starts with "/"
	query       string
	hasQuery    bool
	fragment    string
	hasFragment bool
}

func (u *parsedURL) origin() string {
	if u.port < 0 {
		return u.scheme + "://" + u.host
	}
	return u.scheme + "://" + u.host + ":" + strconv.Itoa(u.port)
}

// search mirrors URL.search: empty unless the query is non-empty.
func (u *parsedURL) search() string {
	if u.query == "" {
		return ""
	}
	return "?" + u.query
}

func (u *parsedURL) hash() string {
	if u.fragment == "" {
		return ""
	}
	return "#" + u.fragment
}

func (u *parsedURL) hasCredentials() bool {
	return u.username != "" || u.password != ""
}

// isLoopback mirrors the TypeScript check against URL.hostname. Its "::1"
// entry never matches — WHATWG keeps the brackets on an IPv6 hostname — so
// IPv6 loopback is deliberately not a loopback here either.
func (u *parsedURL) isLoopback() bool {
	return u.host == "localhost" || u.host == "127.0.0.1"
}

func (u *parsedURL) String() string {
	var b strings.Builder
	b.WriteString(u.scheme)
	b.WriteString("://")
	if u.hasCredentials() {
		b.WriteString(u.username)
		if u.password != "" {
			b.WriteByte(':')
			b.WriteString(u.password)
		}
		b.WriteByte('@')
	}
	b.WriteString(u.host)
	if u.port >= 0 {
		b.WriteByte(':')
		b.WriteString(strconv.Itoa(u.port))
	}
	b.WriteString(u.path)
	if u.hasQuery {
		b.WriteByte('?')
		b.WriteString(u.query)
	}
	if u.hasFragment {
		b.WriteByte('#')
		b.WriteString(u.fragment)
	}
	return b.String()
}

// parseURL parses an absolute http or https URL the way the WHATWG URL
// Standard does. Any other scheme, or a relative reference, is an error.
func parseURL(input string) (*parsedURL, error) {
	input = strings.TrimFunc(input, func(r rune) bool { return r <= 0x20 })
	input = strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, input)

	colon := strings.IndexByte(input, ':')
	if colon < 1 || !isSchemeStart(input[0]) {
		return nil, errInvalidURL
	}
	scheme := strings.ToLower(input[:colon])
	for i := 1; i < colon; i++ {
		if !isSchemeChar(input[i]) {
			return nil, errInvalidURL
		}
	}
	if scheme != "http" && scheme != "https" {
		return nil, errInvalidURL
	}
	rest := strings.TrimLeft(input[colon+1:], `/\`)

	end := strings.IndexAny(rest, `/\?#`)
	if end < 0 {
		end = len(rest)
	}
	authority, rest := rest[:end], rest[end:]

	u := &parsedURL{scheme: scheme, port: -1}
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		userinfo := authority[:at]
		authority = authority[at+1:]
		user, pass, _ := strings.Cut(userinfo, ":")
		u.username = percentEncode(user, isUserinfoEncoded)
		u.password = percentEncode(pass, isUserinfoEncoded)
	}

	hostPart, portPart, hasPort := authority, "", false
	if strings.HasPrefix(authority, "[") {
		closing := strings.IndexByte(authority, ']')
		if closing < 0 {
			return nil, errInvalidURL
		}
		hostPart = authority[:closing+1]
		after := authority[closing+1:]
		if after != "" {
			if after[0] != ':' {
				return nil, errInvalidURL
			}
			portPart, hasPort = after[1:], true
		}
	} else if i := strings.IndexByte(authority, ':'); i >= 0 {
		hostPart, portPart, hasPort = authority[:i], authority[i+1:], true
	}
	if hostPart == "" {
		return nil, errInvalidURL
	}
	host, err := parseHost(hostPart)
	if err != nil {
		return nil, err
	}
	u.host = host
	if hasPort && portPart != "" {
		port := 0
		for i := 0; i < len(portPart); i++ {
			c := portPart[i]
			if c < '0' || c > '9' {
				return nil, errInvalidURL
			}
			port = port*10 + int(c-'0')
			if port > 65535 {
				return nil, errInvalidURL
			}
		}
		if !(scheme == "https" && port == 443) && !(scheme == "http" && port == 80) {
			u.port = port
		}
	}

	if i := strings.IndexByte(rest, '#'); i >= 0 {
		u.fragment = percentEncode(rest[i+1:], isFragmentEncoded)
		u.hasFragment = true
		rest = rest[:i]
	}
	if i := strings.IndexByte(rest, '?'); i >= 0 {
		u.query = percentEncode(rest[i+1:], isSpecialQueryEncoded)
		u.hasQuery = true
		rest = rest[:i]
	}
	u.path = parsePath(rest)
	return u, nil
}

func isSchemeStart(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isSchemeChar(c byte) bool {
	return isSchemeStart(c) || (c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.'
}

// parsePath applies the WHATWG path state for special URLs: both slashes
// separate segments, single- and double-dot segments (including %2e forms)
// are resolved, and each segment is percent-encoded with the path set.
func parsePath(raw string) string {
	if raw != "" && (raw[0] == '/' || raw[0] == '\\') {
		raw = raw[1:]
	}
	segments := []string{}
	for {
		end := strings.IndexAny(raw, `/\`)
		last := end < 0
		buffer := raw
		if !last {
			buffer = raw[:end]
		}
		segment := percentEncode(buffer, isPathEncoded)
		switch {
		case isDoubleDotSegment(segment):
			if len(segments) > 0 {
				segments = segments[:len(segments)-1]
			}
			if last {
				segments = append(segments, "")
			}
		case isSingleDotSegment(segment):
			if last {
				segments = append(segments, "")
			}
		default:
			segments = append(segments, segment)
		}
		if last {
			break
		}
		raw = raw[end+1:]
	}
	return "/" + strings.Join(segments, "/")
}

func isSingleDotSegment(s string) bool {
	return s == "." || strings.EqualFold(s, "%2e")
}

func isDoubleDotSegment(s string) bool {
	switch strings.ToLower(s) {
	case "..", ".%2e", "%2e.", "%2e%2e":
		return true
	}
	return false
}

func isC0ControlEncoded(c byte) bool { return c < 0x20 || c > 0x7e }

func isFragmentEncoded(c byte) bool {
	return isC0ControlEncoded(c) || c == ' ' || c == '"' || c == '<' || c == '>' || c == '`'
}

func isQueryEncoded(c byte) bool {
	return isC0ControlEncoded(c) || c == ' ' || c == '"' || c == '#' || c == '<' || c == '>'
}

func isSpecialQueryEncoded(c byte) bool { return isQueryEncoded(c) || c == '\'' }

func isPathEncoded(c byte) bool {
	return isQueryEncoded(c) || c == '?' || c == '^' || c == '`' || c == '{' || c == '}'
}

func isUserinfoEncoded(c byte) bool {
	return isPathEncoded(c) || c == '/' || c == ':' || c == ';' || c == '=' || c == '@' ||
		(c >= '[' && c <= ']') || c == '|'
}

// percentEncode encodes the UTF-8 bytes of s that fall in the given set.
// Invalid UTF-8 is replaced with U+FFFD first, as the URL parser does.
func percentEncode(s string, encoded func(byte) bool) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if encoded(c) {
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0f])
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

var uts46 = idna.New(
	idna.MapForLookup(),
	idna.Transitional(false),
	idna.CheckHyphens(false),
	idna.CheckJoiners(true),
	idna.BidiRule(),
	idna.StrictDomainName(false),
	idna.VerifyDNSLength(false),
)

func parseHost(input string) (string, error) {
	if strings.HasPrefix(input, "[") {
		if !strings.HasSuffix(input, "]") {
			return "", errInvalidURL
		}
		inner := input[1 : len(input)-1]
		if strings.ContainsRune(inner, '%') {
			return "", errInvalidURL
		}
		addr, err := netip.ParseAddr(inner)
		if err != nil || !addr.Is6() {
			return "", errInvalidURL
		}
		return "[" + serializeIPv6(addr) + "]", nil
	}
	decoded := percentDecode(input)
	if !utf8.ValidString(decoded) {
		decoded = strings.ToValidUTF8(decoded, "�")
	}
	domain, err := domainToASCII(decoded)
	if err != nil || domain == "" {
		return "", errInvalidURL
	}
	for i := 0; i < len(domain); i++ {
		if isForbiddenDomainByte(domain[i]) {
			return "", errInvalidURL
		}
	}
	if endsInNumber(domain) {
		return parseIPv4(domain)
	}
	return domain, nil
}

func domainToASCII(domain string) (string, error) {
	ascii := true
	for i := 0; i < len(domain); i++ {
		if domain[i] >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		punycode := false
		for _, label := range strings.Split(domain, ".") {
			if len(label) >= 4 && strings.EqualFold(label[:4], "xn--") {
				punycode = true
				break
			}
		}
		if !punycode {
			return strings.ToLower(domain), nil
		}
	}
	return uts46.ToASCII(domain)
}

func isForbiddenDomainByte(c byte) bool {
	if c <= 0x20 || c == 0x7f {
		return true
	}
	switch c {
	case '#', '%', '/', ':', '<', '>', '?', '@', '[', '\\', ']', '^', '|':
		return true
	}
	return false
}

func percentDecode(s string) string {
	if !strings.ContainsRune(s, '%') {
		return s
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			out = append(out, unhex(s[i+1])<<4|unhex(s[i+2]))
			i += 2
			continue
		}
		out = append(out, s[i])
	}
	return string(out)
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

func unhex(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	default:
		return c - 'A' + 10
	}
}

func endsInNumber(domain string) bool {
	parts := strings.Split(domain, ".")
	if parts[len(parts)-1] == "" {
		if len(parts) == 1 {
			return false
		}
		parts = parts[:len(parts)-1]
	}
	last := parts[len(parts)-1]
	if last != "" && strings.Trim(last, "0123456789") == "" {
		return true
	}
	_, ok := parseIPv4Number(last)
	return ok
}

func parseIPv4(domain string) (string, error) {
	parts := strings.Split(domain, ".")
	if parts[len(parts)-1] == "" && len(parts) > 1 {
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 4 {
		return "", errInvalidURL
	}
	numbers := make([]uint64, len(parts))
	for i, part := range parts {
		n, ok := parseIPv4Number(part)
		if !ok {
			return "", errInvalidURL
		}
		numbers[i] = n
	}
	for _, n := range numbers[:len(numbers)-1] {
		if n > 255 {
			return "", errInvalidURL
		}
	}
	if numbers[len(numbers)-1] >= uint64(1)<<(8*(5-len(numbers))) {
		return "", errInvalidURL
	}
	ipv4 := numbers[len(numbers)-1]
	for i, n := range numbers[:len(numbers)-1] {
		ipv4 += n << (8 * (3 - i))
	}
	return strconv.FormatUint(ipv4>>24&0xff, 10) + "." + strconv.FormatUint(ipv4>>16&0xff, 10) + "." +
		strconv.FormatUint(ipv4>>8&0xff, 10) + "." + strconv.FormatUint(ipv4&0xff, 10), nil
}

func parseIPv4Number(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	base := 10
	switch {
	case len(s) >= 2 && (s[:2] == "0x" || s[:2] == "0X"):
		base, s = 16, s[2:]
	case len(s) >= 2 && s[0] == '0':
		base, s = 8, s[1:]
	}
	if s == "" {
		return 0, true
	}
	n, err := strconv.ParseUint(s, base, 64)
	if err != nil {
		// Out-of-range digits are still a number; the caller rejects the size.
		var numErr *strconv.NumError
		if errors.As(err, &numErr) && errors.Is(numErr.Err, strconv.ErrRange) {
			return 1 << 40, true
		}
		return 0, false
	}
	return n, true
}

// serializeIPv6 compresses the longest run of two or more zero pieces, and
// never uses the dotted IPv4 form, as the WHATWG serializer does.
func serializeIPv6(addr netip.Addr) string {
	raw := addr.As16()
	var pieces [8]uint16
	for i := range pieces {
		pieces[i] = uint16(raw[2*i])<<8 | uint16(raw[2*i+1])
	}
	bestStart, bestLen := -1, 1
	for i := 0; i < 8; {
		if pieces[i] != 0 {
			i++
			continue
		}
		j := i
		for j < 8 && pieces[j] == 0 {
			j++
		}
		if j-i > bestLen {
			bestStart, bestLen = i, j-i
		}
		i = j
	}
	var b strings.Builder
	for i := 0; i < 8; i++ {
		if i == bestStart {
			b.WriteString("::")
			i += bestLen - 1
			continue
		}
		if i > 0 && i != bestStart+bestLen {
			b.WriteByte(':')
		}
		b.WriteString(strconv.FormatUint(uint64(pieces[i]), 16))
	}
	return b.String()
}
