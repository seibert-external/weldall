"""OAuth error types and response conversion."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .http import Response


class WeldallAuthError(Exception):
    """A protocol error with OAuth code, HTTP status, and optional replay marker."""

    def __init__(
        self,
        code: str,
        message: str | None = None,
        status: int = 400,
        required_scopes: list[str] | tuple[str, ...] = (),
        reason: str | None = None,
    ) -> None:
        self.code = code
        self.message = code if message is None else message
        self.status = status
        self.required_scopes = list(required_scopes)
        self.reason = reason
        super().__init__(self.message)


@dataclass(frozen=True, slots=True)
class ErrorResponse:
    """Tuple-compatible representation useful outside the built-in response model."""

    status: int
    headers: dict[str, str] = field(default_factory=dict)
    body: dict[str, Any] = field(default_factory=dict)

    def __iter__(self):  # type: ignore[no-untyped-def]
        yield self.status
        yield self.headers
        yield self.body


def oauth_error_parts(error: object) -> ErrorResponse:
    if isinstance(error, WeldallAuthError):
        status = error.status
        code = error.code
        description = error.message
        required_scopes = error.required_scopes
    else:
        status = 500
        code = "server_error"
        description = "server error"
        required_scopes = []
    headers = {"cache-control": "no-store", "pragma": "no-cache"}
    if status in (401, 403):
        scope = f', scope="{" ".join(required_scopes)}"' if required_scopes else ""
        headers["www-authenticate"] = f'DPoP error="{code}"{scope}'
    return ErrorResponse(
        status=status,
        headers=headers,
        body={"error": code, "error_description": description},
    )


def oauth_error_response(error: object) -> Response:
    """Return the framework-neutral JSON OAuth error response."""

    parts = oauth_error_parts(error)
    return Response.json(parts.body, status=parts.status, headers=parts.headers)
