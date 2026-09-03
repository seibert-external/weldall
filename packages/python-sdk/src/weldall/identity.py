"""Identity claim validation."""

from __future__ import annotations

import re
from collections.abc import Mapping

_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+$")


def has_verified_email(claims: Mapping[str, object]) -> bool:
    email = claims.get("email")
    return (
        isinstance(email, str)
        and len(email) <= 320
        and email == email.strip()
        and _EMAIL.fullmatch(email) is not None
        and claims.get("email_verified") is True
    )
