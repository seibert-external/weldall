"""Small synchronous HTTP request/response model used by the framework-neutral core."""

from __future__ import annotations

import json
from collections.abc import ItemsView, Mapping
from dataclasses import dataclass, field
from typing import Any


class Headers:
    """Case-insensitive, single-value HTTP headers."""

    def __init__(self, values: Mapping[str, str] | None = None) -> None:
        self._values = {str(key).lower(): str(value) for key, value in (values or {}).items()}

    def get(self, name: str, default: str | None = None) -> str | None:
        return self._values.get(name.lower(), default)

    def __getitem__(self, name: str) -> str:
        return self._values[name.lower()]

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and name.lower() in self._values

    def items(self) -> ItemsView[str, str]:
        return self._values.items()

    def as_dict(self) -> dict[str, str]:
        return dict(self._values)


@dataclass(slots=True)
class Request:
    method: str
    url: str
    headers: Headers | Mapping[str, str] = field(default_factory=Headers)
    body: bytes | str = b""

    def __post_init__(self) -> None:
        self.method = self.method.upper()
        if not isinstance(self.headers, Headers):
            self.headers = Headers(self.headers)
        if isinstance(self.body, str):
            self.body = self.body.encode()

    def text(self) -> str:
        assert isinstance(self.body, bytes)
        return self.body.decode("utf-8", errors="replace")


@dataclass(frozen=True, slots=True)
class Response:
    body: bytes = b""
    status: int = 200
    headers: Headers = field(default_factory=Headers)

    @classmethod
    def json(
        cls,
        value: Any,
        *,
        status: int = 200,
        headers: Mapping[str, str] | None = None,
    ) -> Response:
        values = {"content-type": "application/json"}
        values.update(headers or {})
        return cls(
            json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
            status,
            Headers(values),
        )

    @classmethod
    def empty(cls, *, status: int = 200, headers: Mapping[str, str] | None = None) -> Response:
        return cls(b"", status, Headers(headers))

    def json_body(self) -> Any:
        return json.loads(self.body)

    def text(self) -> str:
        return self.body.decode("utf-8")
