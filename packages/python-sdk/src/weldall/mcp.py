"""Bounded, non-retrying DPoP client for Weldall's private MCP JSON API."""

from __future__ import annotations

import asyncio
import base64
import json
import math
import re
from importlib.resources import files
from typing import Any
from urllib.parse import quote

import httpx
from jsonschema import Draft202012Validator, FormatChecker

from .dpop import create_dpop_proof
from .machine import MachineKey, _absolute_url

_CONTRACT = json.loads(files("weldall").joinpath("mcp-contracts.json").read_text())
MCP_LIMITS: dict[str, int] = _CONTRACT["limits"]
_SCHEMAS = _CONTRACT["schemas"]
_KEY = re.compile(r"^[a-z0-9][a-z0-9._-]{0,119}$")
_URI = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:[^\s\x00-\x1f\x7f]*$")


class WeldallMcpError(Exception):
    def __init__(self, code: str, status: int | None = None) -> None:
        self.code = code
        self.status = status
        super().__init__(
            f"Weldall MCP {code}. No request was retried; execution may already have occurred."
        )


def _bounded_json(value: Any, maximum: int) -> bytes:
    pending = [(value, 0)]
    seen: set[int] = set()
    nodes = 0
    size = 0
    while pending:
        current, depth = pending.pop()
        nodes += 1
        if depth > MCP_LIMITS["jsonDepth"] or nodes > MCP_LIMITS["jsonNodes"]:
            raise ValueError()
        if current is None or isinstance(current, bool):
            continue
        if isinstance(current, (int, float)) and math.isfinite(current):
            continue
        if isinstance(current, str):
            size += len(current.encode())
        elif isinstance(current, (dict, list)) and id(current) not in seen:
            seen.add(id(current))
            if len(current) + len(pending) + nodes > MCP_LIMITS["jsonNodes"]:
                raise ValueError()
            entries = current.items() if isinstance(current, dict) else enumerate(current)
            for key, child in entries:
                if isinstance(current, dict):
                    if not isinstance(key, str) or key in {"__proto__", "constructor", "prototype"}:
                        raise ValueError()
                    size += len(key.encode())
                pending.append((child, depth + 1))
        else:
            raise ValueError()
        if size > maximum:
            raise ValueError()
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    if len(encoded) > maximum:
        raise ValueError()
    return encoded


def _project(schema: dict[str, Any], value: Any, field: str = "") -> Any:
    variants = schema.get("anyOf", schema.get("oneOf"))
    if variants is not None:
        schema = next(s for s in variants if Draft202012Validator(s).is_valid(value))
    if isinstance(value, str):
        if "maxLength" in schema and len(value.encode("utf-16-le")) // 2 > schema["maxLength"]:
            raise ValueError()
        if "x-weldall-maxBytes" in schema and len(value.encode()) > schema["x-weldall-maxBytes"]:
            raise ValueError()
        if field == "uri" and "maxLength" in schema and not _URI.fullmatch(value):
            raise ValueError()
        if (
            field in {"data", "blob"}
            and "maxLength" in schema
            and base64.b64encode(base64.b64decode(value, validate=True)).decode() != value
        ):
            raise ValueError()
        return value
    if isinstance(value, list):
        result = [_project(schema.get("items", {}), item) for item in value]
        if field == "capabilities" and len(set(value)) != len(value):
            raise ValueError()
        return result
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        if not properties:
            additional = schema.get("additionalProperties", {})
            return {
                key: _project(additional if isinstance(additional, dict) else {}, item)
                for key, item in value.items()
            }
        return {
            key: _project(properties.get(key, schema.get("additionalProperties", {})), item, key)
            for key, item in value.items()
            if key in properties or isinstance(schema.get("additionalProperties"), dict)
        }
    return value


def _validate(name: str, value: Any, maximum: int) -> Any:
    _bounded_json(value, maximum)
    schema = _SCHEMAS[name]
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(value)
    result = _project(schema, value)
    if name == "connections":
        for row in result:
            if row["accessMode"] == "SCOPED":
                if row["key"] is None or not row["useScopes"]:
                    raise ValueError()
            elif row["key"] is not None or row["useScopes"]:
                raise ValueError()
    return result


class WeldallMcpClient:
    def __init__(
        self,
        *,
        issuer: str,
        access_token: str,
        key: MachineKey,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        try:
            self._issuer = _absolute_url(issuer, "issuer", True).rstrip("/")
            if not access_token:
                raise ValueError()
        except Exception:
            raise WeldallMcpError("invalid_request") from None
        self._token = access_token
        self._key = key
        self._client = http_client

    async def _request(
        self,
        operation: str,
        *,
        connector_key: str | None = None,
        body: dict[str, Any] | None = None,
    ) -> Any:
        try:
            if connector_key is not None and not _KEY.fullmatch(connector_key):
                raise ValueError()
            encoded = None
            if body is not None:
                contract = {"call": "toolCall", "read-resource": "resourceRead"}.get(
                    operation, "selection"
                )
                body = _validate(contract, body, MCP_LIMITS["requestBytes"])
                encoded = _bounded_json(body, MCP_LIMITS["requestBytes"])
                if connector_key is None:
                    raise ValueError()
        except Exception:
            raise WeldallMcpError("invalid_request") from None
        path = f"/api/me/mcp/{operation}"
        if body is not None:
            path = f"/api/me/mcp/connectors/{quote(connector_key or '', safe='')}/{operation}"
        elif operation == "connections" and connector_key is not None:
            path += f"?connectorKey={quote(connector_key, safe='')}"
        url = self._issuer + path
        method = "GET" if body is None else "POST"
        is_operation = operation in {"call", "read-resource"}
        seconds = MCP_LIMITS["operationMs" if is_operation else "discoveryMs"] / 1000
        maximum = MCP_LIMITS["resultBytes" if is_operation else "definitionsBytes"]
        loop = asyncio.get_running_loop()
        deadline = loop.time() + seconds
        client = self._client or httpx.AsyncClient(follow_redirects=False)
        try:
            proof = create_dpop_proof(
                private_jwk=self._key["private_jwk"],
                public_jwk=self._key["public_jwk"],
                method=method,
                url=url,
                access_token=self._token,
            )
            async with (
                asyncio.timeout_at(deadline),
                client.stream(
                    method,
                    url,
                    content=encoded,
                    follow_redirects=False,
                    timeout=seconds,
                    headers={
                        "authorization": f"DPoP {self._token}",
                        "dpop": proof,
                        "accept": "application/json",
                        "content-type": "application/json",
                    },
                ) as response,
            ):
                if not response.is_success:
                    raise WeldallMcpError("request_failed", response.status_code)
                if int(response.headers.get("content-length", "0")) > maximum:
                    raise WeldallMcpError("invalid_response")
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    if loop.time() >= deadline:
                        raise WeldallMcpError("timeout")
                    if len(data) + len(chunk) > maximum:
                        raise WeldallMcpError("invalid_response")
                    data.extend(chunk)
                try:
                    result = _validate(operation, json.loads(data), maximum)
                except Exception:
                    raise WeldallMcpError("invalid_response") from None
                if loop.time() >= deadline:
                    raise WeldallMcpError("timeout")
                return result
        except (TimeoutError, httpx.TimeoutException):
            raise WeldallMcpError("timeout") from None
        except WeldallMcpError:
            raise
        except Exception:
            raise WeldallMcpError("request_failed") from None
        finally:
            if self._client is None:
                await client.aclose()

    async def list_connectors(self) -> list[dict[str, Any]]:
        return await self._request("connectors")  # type: ignore[no-any-return]

    async def list_connections(self, *, connector_key: str | None = None) -> list[dict[str, Any]]:
        return await self._request("connections", connector_key=connector_key)  # type: ignore[no-any-return]

    async def list_tools(self, *, connector_key: str, connection: str) -> dict[str, Any]:
        result: dict[str, Any] = await self._request(
            "tools", connector_key=connector_key, body={"connection": connection}
        )
        return result

    async def list_resources(self, *, connector_key: str, connection: str) -> dict[str, Any]:
        result: dict[str, Any] = await self._request(
            "resources", connector_key=connector_key, body={"connection": connection}
        )
        return result

    async def call_tool(
        self, *, connector_key: str, connection: str, name: str, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        result: dict[str, Any] = await self._request(
            "call",
            connector_key=connector_key,
            body={"connection": connection, "name": name, "arguments": arguments},
        )
        return result

    async def read_resource(
        self, *, connector_key: str, connection: str, uri: str
    ) -> dict[str, Any]:
        result: dict[str, Any] = await self._request(
            "read-resource",
            connector_key=connector_key,
            body={"connection": connection, "uri": uri},
        )
        return result


def create_weldall_mcp_client(
    *, issuer: str, access_token: str, key: MachineKey, http_client: httpx.AsyncClient | None = None
) -> WeldallMcpClient:
    return WeldallMcpClient(
        issuer=issuer, access_token=access_token, key=key, http_client=http_client
    )
