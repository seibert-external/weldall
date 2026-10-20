"""Optional native MCP serving over stateless Streamable HTTP/JSON.

Authentication stays in Weldall's core. Handlers are async so cancellation/deadlines
propagate without leaving an untracked worker executing a potentially mutating call.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any, NotRequired, TypedDict
from urllib.parse import urljoin

from jsonschema import Draft202012Validator
from referencing import Registry

from .errors import WeldallAuthError
from .http import Request, Response
from .mcp import MCP_LIMITS, _bounded_json, _validate
from .types import AuthContext

_PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")


@dataclass(frozen=True, slots=True)
class NativeMcpContext:
    auth: AuthContext


class NativeMcpTool(TypedDict):
    name: str
    inputSchema: dict[str, Any]
    scopes: Sequence[str]
    handler: Callable[[dict[str, Any], NativeMcpContext], Awaitable[dict[str, Any]]]
    title: NotRequired[str]
    description: NotRequired[str]
    outputSchema: NotRequired[dict[str, Any]]
    annotations: NotRequired[dict[str, Any]]


class NativeMcpResource(TypedDict):
    name: str
    uri: str
    scopes: Sequence[str]
    handler: Callable[[NativeMcpContext], Awaitable[dict[str, Any]]]
    title: NotRequired[str]
    description: NotRequired[str]
    mimeType: NotRequired[str]
    size: NotRequired[int]
    annotations: NotRequired[dict[str, Any]]


class _RpcError(Exception):
    def __init__(self, code: int, message: str) -> None:
        self.code, self.message = code, message


def _require_scopes(auth: AuthContext, scopes: Sequence[str]) -> None:
    if any(scope not in auth.scopes for scope in scopes):
        raise _RpcError(-32003, "Required operation scope is missing")


def _scopes(values: Sequence[str]) -> list[str]:
    return sorted(_validate("nativeScopes", list(values), MCP_LIMITS["definitionsBytes"]))


class NativeMcp:
    """An immutable catalog; no session pooling, credentials, or business-result cache."""

    def __init__(
        self,
        *,
        path: str,
        description: str,
        discovery_scopes: Sequence[str],
        tools: Sequence[NativeMcpTool],
        resources: Sequence[NativeMcpResource] = (),
    ) -> None:
        if not re.fullmatch(r"/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+", path):
            raise ValueError("Invalid native MCP path")
        self._path = path
        self._discovery_scopes = tuple(_scopes(discovery_scopes))
        self._tool_handlers = {tool["name"]: tool["handler"] for tool in tools}
        self._resource_handlers = {resource["uri"]: resource["handler"] for resource in resources}
        if (
            len(self._tool_handlers) != len(tools)
            or len(self._resource_handlers) != len(resources)
            or not all(callable(item) for item in self._tool_handlers.values())
            or not all(callable(item) for item in self._resource_handlers.values())
        ):
            raise ValueError("Duplicate native MCP entries or invalid handlers")

        def definition(item: Any) -> dict[str, Any]:
            return {
                **copy.deepcopy({k: v for k, v in item.items() if k not in {"handler", "scopes"}}),
                "_meta": {"weldall/scopes": _scopes(item["scopes"])},
            }

        maximum = MCP_LIMITS["definitionsBytes"]
        self._tools = _validate("nativeTools", {"tools": [definition(t) for t in tools]}, maximum)[
            "tools"
        ]
        self._resources = _validate(
            "nativeResources", {"resources": [definition(r) for r in resources]}, maximum
        )["resources"]
        catalog = {"tools": self._tools, "resources": self._resources}
        _bounded_json(catalog, maximum)
        self._validators = {}
        self._output_validators = {}
        for tool in self._tools:
            Draft202012Validator.check_schema(tool["inputSchema"])
            self._validators[tool["name"]] = Draft202012Validator(
                tool["inputSchema"], registry=Registry()
            )
            if "outputSchema" in tool:
                Draft202012Validator.check_schema(tool["outputSchema"])
                self._output_validators[tool["name"]] = Draft202012Validator(
                    tool["outputSchema"], registry=Registry()
                )
        self._operation_scopes = tuple(
            sorted(
                {
                    s
                    for item in [*self._tools, *self._resources]
                    for s in item["_meta"]["weldall/scopes"]
                }
            )
        )
        revision = hashlib.sha256(
            json.dumps(
                {
                    "path": path,
                    "description": description,
                    "discoveryScopes": list(self.discovery_scopes),
                    "catalog": catalog,
                },
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            ).encode()
        ).hexdigest()
        self._metadata = _validate(
            "nativeMetadata",
            {
                "schemaVersion": 1,
                "transport": "streamable-http-stateless",
                "endpoint": f"https://metadata.invalid{path}",
                "description": description,
                "discoveryScopes": list(self.discovery_scopes),
                "capabilities": ["tools", "resources"],
                "revision": revision,
            },
            maximum,
        )

    @property
    def path(self) -> str:
        return self._path

    @property
    def discovery_scopes(self) -> tuple[str, ...]:
        return self._discovery_scopes

    @property
    def operation_scopes(self) -> tuple[str, ...]:
        return self._operation_scopes

    def metadata(self, public_origin: str) -> dict[str, Any]:
        return {**copy.deepcopy(self._metadata), "endpoint": urljoin(public_origin, self.path)}

    async def handle(self, request: Request, auth: AuthContext) -> Response:
        headers = {"cache-control": "private, no-store"}
        if request.method != "POST":
            return Response.empty(status=405, headers={**headers, "allow": "POST"})
        _require_scopes(auth, self.discovery_scopes)
        if len(request.body) > MCP_LIMITS["requestBytes"]:
            return Response.json({"error": "request_too_large"}, status=413, headers=headers)
        accept = request.headers.get("accept", "") or ""
        if "application/json" not in accept or "text/event-stream" not in accept:
            return Response.json({"error": "not_acceptable"}, status=406, headers=headers)
        if (request.headers.get("content-type", "") or "").split(";", 1)[0] != "application/json":
            return Response.json({"error": "unsupported_media_type"}, status=415, headers=headers)
        if request.headers.get("mcp-protocol-version", "2025-03-26") not in _PROTOCOLS:
            return Response.json(
                {"error": "unsupported_protocol_version"}, status=400, headers=headers
            )
        rpc_id: str | int | None = None
        try:
            try:
                message = json.loads(request.body)
            except (ValueError, UnicodeError, RecursionError) as error:
                raise _RpcError(-32700, "Parse error") from error
            if (
                not isinstance(message, dict)
                or message.get("jsonrpc") != "2.0"
                or not isinstance(message.get("method"), str)
                or ("params" in message and not isinstance(message["params"], dict))
                or ("id" in message and (type(message["id"]) not in (str, int)))
            ):
                raise _RpcError(-32600, "Invalid request")
            rpc_id = message.get("id")
            if "id" not in message:
                return Response.empty(status=202, headers=headers)
            try:
                _bounded_json(message, MCP_LIMITS["requestBytes"])
            except ValueError as error:
                raise _RpcError(-32602, "Invalid parameters") from error
            async with asyncio.timeout(MCP_LIMITS["operationMs"] / 1000):
                result = await self._dispatch(message["method"], message.get("params", {}), auth)
            return Response.json(
                {"jsonrpc": "2.0", "id": rpc_id, "result": result}, headers=headers
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if isinstance(error, _RpcError):
                code, description = error.code, error.message
            elif isinstance(error, WeldallAuthError):
                code, description = -32003, "Operation not permitted"
            else:
                code, description = -32603, "Operation failed; do not retry automatically"
            return Response.json(
                {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": description}},
                headers=headers,
            )

    async def _dispatch(
        self, method: str, params: dict[str, Any], auth: AuthContext
    ) -> dict[str, Any]:
        if method == "initialize":
            if (
                not isinstance(params.get("protocolVersion"), str)
                or not isinstance(params.get("capabilities"), dict)
                or not isinstance(params.get("clientInfo"), dict)
            ):
                raise _RpcError(-32602, "Invalid initialization")
            protocol_version = (
                params["protocolVersion"]
                if params["protocolVersion"] in _PROTOCOLS
                else _PROTOCOLS[0]
            )
            return {
                "protocolVersion": protocol_version,
                "capabilities": {"tools": {}, "resources": {}},
                "serverInfo": {"name": "weldall-native", "version": "1.0.0"},
            }
        if method == "ping":
            return {}
        if method in {"tools/list", "resources/list", "resources/templates/list"}:
            if "cursor" in params:
                raise _RpcError(-32602, "Unknown cursor")
            if method == "tools/list":
                return {"tools": self._tools}
            if method == "resources/list":
                return {"resources": self._resources}
            return {"resourceTemplates": []}
        context = NativeMcpContext(auth=auth)
        if method == "tools/call":
            tool = next((t for t in self._tools if t["name"] == params.get("name")), None)
            if tool is None:
                raise _RpcError(-32602, "Unknown tool")
            _require_scopes(auth, tool["_meta"]["weldall/scopes"])
            arguments = params.get("arguments", {})
            if not self._validators[tool["name"]].is_valid(arguments):
                raise _RpcError(-32602, "Invalid tool arguments")
            result: dict[str, Any] = _validate(
                "call",
                await self._tool_handlers[tool["name"]](arguments, context),
                MCP_LIMITS["resultBytes"],
            )
            output_validator = self._output_validators.get(tool["name"])
            if (
                output_validator
                and not result.get("isError")
                and not output_validator.is_valid(result.get("structuredContent"))
            ):
                raise _RpcError(-32603, "Invalid tool result; do not retry automatically")
            return result
        if method == "resources/read":
            resource = next((r for r in self._resources if r["uri"] == params.get("uri")), None)
            if resource is None:
                raise _RpcError(-32602, "Unknown resource")
            _require_scopes(auth, resource["_meta"]["weldall/scopes"])
            value: dict[str, Any] = _validate(
                "read-resource",
                await self._resource_handlers[resource["uri"]](context),
                MCP_LIMITS["resultBytes"],
            )
            return value
        raise _RpcError(-32601, "Method not found")


def create_native_mcp(
    *,
    path: str,
    description: str,
    discovery_scopes: Sequence[str],
    tools: Sequence[NativeMcpTool],
    resources: Sequence[NativeMcpResource] = (),
) -> NativeMcp:
    return NativeMcp(
        path=path,
        description=description,
        discovery_scopes=discovery_scopes,
        tools=tools,
        resources=resources,
    )
