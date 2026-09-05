"""Resource registry URL normalization and prefix matching."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import TypeVar, cast
from urllib.parse import urlsplit

from ._url import has_credentials, parse_absolute, serialize

T = TypeVar("T", bound=Mapping[str, object])


def _https(value: str, label: str):  # type: ignore[no-untyped-def]
    try:
        parsed = parse_absolute(value, label)
    except TypeError as error:
        raise TypeError(f"{label} must be an absolute HTTPS URL") from error
    if parsed.scheme.lower() != "https" or has_credentials(parsed):
        raise TypeError(f"{label} must be HTTPS and must not contain credentials")
    return parsed


def normalize_resource_identifier(value: str) -> str:
    parsed = _https(value.strip(), "Resource identifier")
    if parsed.fragment:
        raise TypeError("Resource identifier must not contain a fragment")
    return serialize(parsed)


def normalize_authorization_server(value: str) -> str:
    parsed = _https(value.strip(), "Authorization server")
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise TypeError(
            "Authorization server must be an HTTPS origin without path, query, or fragment"
        )
    return serialize(parsed, path="", query="", fragment="").rstrip("/")


def normalize_request_prefix(value: str) -> str:
    parsed = _https(value.strip(), "Request prefix")
    if parsed.query or parsed.fragment:
        raise TypeError("Request prefix must not contain a query or fragment")
    if "%" in parsed.path:
        raise TypeError("Request prefix paths must not contain percent encoding")
    path = parsed.path or "/"
    if len(path) > 1:
        path = re.sub(r"/+$", "", path) or "/"
    return serialize(parsed, path=path, query="", fragment="")


def normalize_request_target(value: str) -> str:
    parsed = _https(str(value), "Request URL")
    if parsed.fragment:
        raise TypeError("Request URL must not contain a fragment")
    if "%" in parsed.path:
        raise TypeError("Request URL paths must not contain percent encoding")
    return serialize(parsed)


def _origin(value: str) -> str:
    parsed = parse_absolute(value)
    return serialize(parsed, path="", query="", fragment="").rstrip("/")


def request_prefix_accepts(prefix_value: str, target_value: str) -> bool:
    prefix = normalize_request_prefix(prefix_value)
    target = normalize_request_target(str(target_value))
    prefix_url = urlsplit(prefix)
    target_url = urlsplit(target)
    if _origin(prefix) != _origin(target):
        return False
    prefix_path = prefix_url.path
    target_path = target_url.path
    return (
        prefix_path == "/"
        or target_path == prefix_path
        or target_path.startswith(f"{prefix_path}/")
    )


def request_prefixes_overlap(left_value: str, right_value: str) -> bool:
    left = normalize_request_prefix(left_value)
    right = normalize_request_prefix(right_value)
    return request_prefix_accepts(left, right) or request_prefix_accepts(right, left)


def resolve_resource_for_target(resources: Sequence[T], target: str) -> list[T]:
    result: list[T] = []
    for resource in resources:
        prefixes = cast(Sequence[str], resource["request_prefixes"])
        if any(request_prefix_accepts(prefix, target) for prefix in prefixes):
            result.append(resource)
    return result
