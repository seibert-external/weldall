"""Security-focused WHATWG-style URL normalization used by the protocol."""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import quote, unquote, urlsplit

import idna

_LOOPBACKS = {"localhost", "127.0.0.1", "::1"}
_FORBIDDEN_HOST = re.compile(r"[\x00-\x20%/#:<>?@\[\]\\^|]")
_ENCODED_DOT = re.compile(r"%2e", re.IGNORECASE)
_PATH_SAFE = "/!$&'()*+,-.:;=@_~%[]|"
_QUERY_SAFE = "!$&()*+,-./:;=?@_~%[]\\^`{|}"
_FRAGMENT_SAFE = "!#$&'()*+,-./:;=?@_~%[]\\^{|}"


@dataclass(frozen=True, slots=True)
class ParsedUrl:
    scheme: str
    path: str
    query: str
    fragment: str
    hostname: str
    port: int | None
    username: str | None
    password: str | None
    query_present: bool = False
    fragment_present: bool = False


def _special_backslashes(value: str) -> str:
    """WHATWG treats backslashes as slashes before query/fragment in HTTP URLs."""

    separator = min(
        (index for mark in "?#" if (index := value.find(mark)) >= 0), default=len(value)
    )
    head, tail = value[:separator], value[separator:]
    if head.lower().startswith(("http:", "https:")):
        head = head.replace("\\", "/")
        match = re.match(r"(?i)^(https?):/*", head)
        assert match is not None
        head = f"{match.group(1)}://{head[match.end() :]}"
    return head + tail


def _parse_ipv4_number(value: str) -> int:
    base = 10
    digits = value
    if value.lower().startswith("0x"):
        base = 16
        digits = value[2:]
    elif len(value) >= 2 and value.startswith("0"):
        base = 8
        digits = value[1:]
    if not digits:
        if value.lower() == "0x":
            return 0
        raise ValueError("invalid IPv4 number")
    valid = {
        8: r"[0-7]+",
        10: r"[0-9]+",
        16: r"[0-9a-fA-F]+",
    }[base]
    if re.fullmatch(valid, digits) is None:
        raise ValueError("invalid IPv4 number")
    return int(digits, base)


def _canonical_ipv4(domain: str) -> str:
    parts = domain.split(".")
    if parts[-1] == "":
        parts.pop()
    if not parts:
        raise ValueError("invalid IPv4 address")
    last = parts[-1]
    try:
        last_is_number = last.isascii() and last.isdigit()
        _parse_ipv4_number(last)
        last_is_number = True
    except ValueError:
        last_is_number = last.isascii() and last.isdigit()
    if not last_is_number:
        return domain
    if len(parts) > 4:
        raise ValueError("invalid IPv4 address")
    numbers = [_parse_ipv4_number(part) for part in parts]
    if any(number > 255 for number in numbers[:-1]):
        raise ValueError("invalid IPv4 address")
    if numbers[-1] >= 256 ** (5 - len(numbers)):
        raise ValueError("invalid IPv4 address")
    ipv4 = numbers[-1]
    for index, number in enumerate(numbers[:-1]):
        ipv4 += number * 256 ** (3 - index)
    return ".".join(str((ipv4 >> shift) & 0xFF) for shift in (24, 16, 8, 0))


def _serialize_ipv6(address: ipaddress.IPv6Address) -> str:
    value = int(address)
    pieces = [format((value >> shift) & 0xFFFF, "x") for shift in range(112, -1, -16)]
    best_start = -1
    best_length = 1
    index = 0
    while index < len(pieces):
        if pieces[index] != "0":
            index += 1
            continue
        end = index
        while end < len(pieces) and pieces[end] == "0":
            end += 1
        if end - index > best_length:
            best_start = index
            best_length = end - index
        index = end
    if best_start < 0:
        return ":".join(pieces)
    left = ":".join(pieces[:best_start])
    right = ":".join(pieces[best_start + best_length :])
    return f"{left}::{right}"


def _canonical_hostname(hostname: str) -> str:
    if ":" in hostname:  # IPv6, without brackets after urlsplit().
        if "%" in hostname:
            raise ValueError("invalid IPv6 hostname")
        try:
            return _serialize_ipv6(ipaddress.IPv6Address(hostname))
        except ipaddress.AddressValueError as error:
            raise ValueError("invalid IPv6 hostname") from error
    try:
        decoded = unquote(hostname, encoding="utf-8", errors="strict")
    except (UnicodeDecodeError, ValueError) as error:
        raise ValueError("invalid hostname") from error
    if not decoded or _FORBIDDEN_HOST.search(decoded) or ":" in decoded:
        raise ValueError("invalid hostname")
    try:
        domain = idna.encode(decoded, uts46=True).decode("ascii").lower()
    except idna.IDNAError as idna_error:
        # Invalid A-labels remain invalid under WHATWG host parsing. For other
        # non-strict cases (for example symbols and underscores), the stdlib
        # codec provides the permissive ASCII conversion used by URL hosts.
        if any(label.lower().startswith("xn--") for label in decoded.split(".")):
            raise ValueError("invalid hostname") from idna_error
        if decoded.isascii():
            domain = decoded.lower()
        else:
            try:
                domain = decoded.encode("idna").decode("ascii").lower()
            except UnicodeError as error:
                raise ValueError("invalid hostname") from error
    return _canonical_ipv4(domain)


def parse_absolute(value: str, label: str = "URL") -> ParsedUrl:
    if not isinstance(value, str):
        raise TypeError(f"{label} must be an absolute URL")
    candidate = _special_backslashes(value)
    try:
        split = urlsplit(candidate)
        raw_hostname = split.hostname
        port = split.port
        if not split.scheme or raw_hostname is None:
            raise ValueError("relative URL")
        hostname = _canonical_hostname(raw_hostname)
        path = quote(
            normalized_path(split.path), safe=_PATH_SAFE, encoding="utf-8", errors="strict"
        )
        query = quote(split.query, safe=_QUERY_SAFE, encoding="utf-8", errors="strict")
        fragment = quote(split.fragment, safe=_FRAGMENT_SAFE, encoding="utf-8", errors="strict")
    except (ValueError, UnicodeError) as error:
        raise TypeError(f"{label} must be an absolute URL") from error
    before_fragment = candidate.split("#", 1)[0]
    return ParsedUrl(
        scheme=split.scheme.lower(),
        path=path or "/",
        query=query,
        fragment=fragment,
        hostname=hostname,
        port=port,
        username=split.username,
        password=split.password,
        query_present="?" in before_fragment,
        fragment_present="#" in candidate,
    )


def _dot_kind(segment: str) -> int:
    decoded = _ENCODED_DOT.sub(".", segment).lower()
    if decoded == ".":
        return 1
    if decoded == "..":
        return 2
    return 0


def normalized_path(path: str) -> str:
    """Apply the special-scheme WHATWG dot-segment shortening algorithm."""

    if not path:
        return "/"
    absolute = path.startswith("/")
    segments = path.split("/")
    output: list[str] = []
    for index, segment in enumerate(segments):
        kind = _dot_kind(segment)
        last = index == len(segments) - 1
        if kind == 1:
            if last:
                output.append("")
            continue
        if kind == 2:
            if output and not (absolute and len(output) == 1 and output[0] == ""):
                output.pop()
            if last:
                output.append("")
            continue
        output.append(segment)
    result = "/".join(output)
    if absolute and not result.startswith("/"):
        result = "/" + result
    return result or ("/" if absolute else "")


def netloc(parsed: ParsedUrl, *, drop_default_port: bool = True) -> str:
    host = parsed.hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    port = parsed.port
    if drop_default_port and (
        (parsed.scheme == "https" and port == 443) or (parsed.scheme == "http" and port == 80)
    ):
        port = None
    return host if port is None else f"{host}:{port}"


def serialize(
    parsed: ParsedUrl,
    *,
    path: str | None = None,
    query: str | None = None,
    fragment: str | None = None,
) -> str:
    normalized = quote(
        normalized_path(parsed.path if path is None else path),
        safe=_PATH_SAFE,
        encoding="utf-8",
        errors="strict",
    )
    result = f"{parsed.scheme}://{netloc(parsed)}{normalized or '/'}"
    if query is None:
        if parsed.query_present:
            result += f"?{parsed.query}"
    elif query:
        result += f"?{quote(query, safe=_QUERY_SAFE, encoding='utf-8', errors='strict')}"
    if fragment is None:
        if parsed.fragment_present:
            result += f"#{parsed.fragment}"
    elif fragment:
        result += f"#{quote(fragment, safe=_FRAGMENT_SAFE, encoding='utf-8', errors='strict')}"
    return result


def is_loopback(parsed: ParsedUrl) -> bool:
    return parsed.hostname in _LOOPBACKS


def has_credentials(parsed: ParsedUrl) -> bool:
    return parsed.username is not None or parsed.password is not None
