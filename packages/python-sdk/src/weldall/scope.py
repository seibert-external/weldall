"""OAuth scope parsing."""

from __future__ import annotations

import re

_SCOPE_TOKEN = re.compile(r"^[\x21\x23-\x5b\x5d-\x7e]+$")


def parse_scope(value: object) -> list[str] | None:
    if not isinstance(value, str) or not value:
        return None
    scopes = value.split(" ")
    if any(not _SCOPE_TOKEN.fullmatch(scope) for scope in scopes) or len(set(scopes)) != len(
        scopes
    ):
        return None
    return scopes
