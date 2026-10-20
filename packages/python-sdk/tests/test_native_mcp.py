from __future__ import annotations

import asyncio
import copy
import json

import httpx
import pytest
from conftest import CLIENT_ID, ORIGIN, RESOURCE, make_sdk
from jsonschema import ValidationError
from test_machine import machine_token

from weldall import Request, create_dpop_proof, issue_access_token
from weldall.mcp import MCP_LIMITS
from weldall.native_mcp import create_native_mcp

pytestmark = pytest.mark.anyio
ENDPOINT = f"{ORIGIN}/api/mcp"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def provider(*, scopes=("read",), write=None):
    async def read(_arguments, context):
        return {"content": [{"type": "text", "text": context.auth.subject}]}

    async def resource(context):
        return {"contents": [{"uri": "expenses://current", "text": context.auth.subject}]}

    return create_native_mcp(
        path="/api/mcp",
        description="Expenses",
        discovery_scopes=scopes,
        tools=[
            {
                "name": "read",
                "inputSchema": {"type": "object"},
                "scopes": ["read"],
                "handler": read,
            },
            {
                "name": "write",
                "inputSchema": {
                    "type": "object",
                    "required": ["title"],
                    "properties": {"title": {"type": "string"}},
                },
                "scopes": ["write"],
                "handler": write or read,
            },
        ],
        resources=[
            {
                "name": "Current",
                "uri": "expenses://current",
                "scopes": ["write"],
                "handler": resource,
            }
        ],
    )


def request(
    keys,
    method="tools/list",
    params=None,
    scopes=("read",),
    *,
    machine=False,
    patch=None,
    headers=None,
    http_method="POST",
):
    if machine:
        token = machine_token(keys, {"scope": " ".join(scopes), **(patch or {})})
        key = keys.machine
    else:
        token = issue_access_token(
            **{
                "issuer": ORIGIN,
                "resource": RESOURCE,
                "client_id": CLIENT_ID,
                "subject": "user-1",
                "email": "user@example.com",
                "scopes": list(scopes),
                "jkt": keys.device["jkt"],
                "kid": "local",
                "private_jwk": keys.local["private_jwk"],
                **(patch or {}),
            }
        )
        key = keys.device
    return Request(
        http_method,
        ENDPOINT,
        {
            "authorization": f"DPoP {token}",
            "dpop": create_dpop_proof(**key, method=http_method, url=ENDPOINT, access_token=token),
            "accept": "application/json, text/event-stream",
            "content-type": "application/json",
            **(headers or {}),
        },
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}),
    )


@pytest.mark.parametrize("scopes", [[], [""], ["read", "read"], ["has space"]])
async def test_requires_nonempty_unique_scope_policy(scopes):
    with pytest.raises((ValueError, ValidationError)):
        provider(scopes=scopes)


async def test_draft_2020_12_input_and_output_validation(keys, discovery):
    from test_interop import ROOT

    schema = json.loads((ROOT / "packages/sdk/test/fixtures/native-schema.json").read_text())
    calls = []
    output = {"amount": 10}

    async def charge(arguments, _context):
        calls.append(arguments)
        return {
            "content": [{"type": "text", "text": "charged"}],
            "structuredContent": output,
        }

    sdk = make_sdk(
        keys,
        discovery,
        mcp=create_native_mcp(
            path="/api/mcp",
            description="Schema validation",
            discovery_scopes=["read"],
            tools=[
                {
                    "name": "charge",
                    "scopes": ["write"],
                    "inputSchema": schema,
                    "outputSchema": copy.deepcopy(schema),
                    "handler": charge,
                }
            ],
        ),
    )

    async def call(arguments):
        response = await sdk.handlers.mcp(
            request(
                keys,
                "tools/call",
                {"name": "charge", "arguments": arguments},
                scopes=["read", "write"],
            )
        )
        return response.json_body()

    assert (await call({"amount": 10}))["error"]["code"] == -32602
    assert not calls
    assert (await call({"amount": 10, "currency": "EUR"}))["error"]["code"] == -32603
    assert len(calls) == 1
    output["currency"] = "EUR"
    assert (await call(output))["result"]["structuredContent"] == output
    assert len(calls) == 2


async def test_metadata_and_http_only_remain_separate(keys, discovery):
    sdk = make_sdk(keys, discovery, mcp=provider())
    metadata = sdk.handlers.protected_resource_metadata().json_body()["weldall_mcp"]
    assert metadata["endpoint"] == ENDPOINT
    assert metadata["discoveryScopes"] == ["read"]
    assert metadata["capabilities"] == ["tools", "resources"]
    assert metadata["transport"] == "streamable-http-stateless"
    assert len(metadata["revision"]) == 64
    metadata["discoveryScopes"].clear()
    assert sdk.mcp_metadata["discoveryScopes"] == ["read"]
    normal = make_sdk(keys, discovery)
    assert "weldall_mcp" not in normal.handlers.protected_resource_metadata().json_body()
    assert (await normal.handlers.mcp(request(keys))).status == 404
    with pytest.raises(TypeError):
        make_sdk(keys, discovery, mcp=provider(), replay_store="disabled")
    with pytest.raises(TypeError):
        make_sdk(keys, discovery, mcp=provider(), supported_scopes=["read"])


@pytest.mark.parametrize(
    "method", ["initialize", "tools/list", "resources/list", "resources/templates/list"]
)
async def test_every_listing_requires_all_discovery_scopes(keys, discovery, method):
    sdk = make_sdk(keys, discovery, mcp=provider(scopes=["read", "admin"]))
    assert (await sdk.handlers.mcp(Request("POST", ENDPOINT))).status == 401
    assert (await sdk.handlers.mcp(request(keys, method))).status == 403
    allowed = await sdk.handlers.mcp(
        request(
            keys,
            method,
            {
                "protocolVersion": "2025-11-25",
                "clientInfo": {"name": "test", "version": "1"},
                "capabilities": {},
            },
            scopes=["read", "admin"],
        )
    )
    assert allowed.status == 200
    assert "result" in allowed.json_body()


@pytest.mark.parametrize("machine", [False, True])
async def test_verified_user_and_machine_and_operation_denials(keys, discovery, machine):
    calls = []

    async def write(arguments, context):
        calls.append((arguments, context.auth))
        return {
            "content": [
                {"type": "text", "text": context.auth.identity.type, "_meta": {"ui": "discard"}}
            ]
        }

    sdk = make_sdk(keys, discovery, mcp=provider(write=write))
    listed = (await sdk.handlers.mcp(request(keys, machine=machine))).json_body()["result"]["tools"]
    assert listed[1]["_meta"] == {"weldall/scopes": ["write"]}
    denied = await sdk.handlers.mcp(
        request(
            keys, "tools/call", {"name": "write", "arguments": {"title": "New"}}, machine=machine
        )
    )
    assert denied.json_body()["error"]["code"] == -32003
    assert calls == []
    denied_read = await sdk.handlers.mcp(
        request(keys, "resources/read", {"uri": "expenses://current"}, machine=machine)
    )
    assert denied_read.json_body()["error"]["code"] == -32003
    invalid = await sdk.handlers.mcp(
        request(
            keys,
            "tools/call",
            {"name": "write", "arguments": {"title": 1}},
            scopes=["read", "write"],
            machine=machine,
        )
    )
    assert invalid.json_body()["error"]["code"] == -32602
    assert calls == []
    result = await sdk.handlers.mcp(
        request(
            keys,
            "tools/call",
            {"name": "write", "arguments": {"title": "New"}},
            scopes=["read", "write"],
            machine=machine,
        )
    )
    identity = "machine" if machine else "user"
    assert result.json_body()["result"] == {"content": [{"type": "text", "text": identity}]}
    assert calls[0][1].identity.type == identity
    assert calls[0][0] == {"title": "New"}
    read = await sdk.handlers.mcp(
        request(
            keys,
            "resources/read",
            {"uri": "expenses://current"},
            scopes=["read", "write"],
            machine=machine,
        )
    )
    assert read.json_body()["result"]["contents"][0]["text"] == calls[0][1].subject


async def test_identity_replay_origin_revision_and_methods(keys, discovery):
    sdk = make_sdk(keys, discovery, mcp=provider())
    original = request(keys)
    assert (await sdk.handlers.mcp(original)).status == 200
    assert (await sdk.handlers.mcp(original)).status == 401
    assert (
        await sdk.handlers.mcp(request(keys, patch={"resource": "https://wrong.example/api"}))
    ).status == 401
    assert (
        await sdk.handlers.mcp(request(keys, patch={"issuer": "https://wrong.example"}))
    ).status == 401
    assert (
        await sdk.handlers.mcp(request(keys, headers={"origin": "https://wrong.example"}))
    ).status == 403
    assert (
        await sdk.handlers.mcp(request(keys, headers={"weldall-mcp-revision": "stale"}))
    ).status == 409
    for method in ["GET", "DELETE"]:
        response = await sdk.handlers.mcp(request(keys, http_method=method))
        assert response.status == 405
        assert response.headers.get("allow") == "POST"
    assert (await sdk.handlers.mcp(request(keys))).headers.get(
        "weldall-mcp-revision"
    ) == sdk.mcp_metadata["revision"]


async def test_protocol_validation_limits_and_no_sessions(keys, discovery):
    sdk = make_sdk(keys, discovery, mcp=provider())
    for headers, expected in [
        ({"accept": "application/json"}, 406),
        ({"content-type": "text/plain"}, 415),
        ({"mcp-protocol-version": "invalid"}, 400),
    ]:
        assert (await sdk.handlers.mcp(request(keys, headers=headers))).status == expected
    malformed = request(keys)
    malformed.body = b"{"
    assert (await sdk.handlers.mcp(malformed)).json_body()["error"]["code"] == -32700
    batch = request(keys)
    batch.body = b"[]"
    assert (await sdk.handlers.mcp(batch)).json_body()["error"]["code"] == -32600
    large = request(keys)
    large.body = b" " * (MCP_LIMITS["requestBytes"] + 1)
    assert (await sdk.handlers.mcp(large)).status == 413
    notified = request(keys)
    notified.body = b'{"jsonrpc":"2.0","method":"notifications/initialized"}'
    response = await sdk.handlers.mcp(notified)
    assert response.status == 202
    assert response.headers.get("mcp-session-id") is None
    assert (await sdk.handlers.mcp(request(keys, params={"cursor": "anything"}))).json_body()[
        "error"
    ]["code"] == -32602


async def test_initialize_negotiates_to_latest_supported_protocol(keys, discovery):
    sdk = make_sdk(keys, discovery, mcp=provider())
    response = await sdk.handlers.mcp(
        request(
            keys,
            "initialize",
            {
                "protocolVersion": "2099-01-01",
                "clientInfo": {"name": "test", "version": "1"},
                "capabilities": {},
            },
        )
    )
    assert response.json_body()["result"]["protocolVersion"] == "2025-11-25"


async def test_cancellation_and_timeout_cancel_handler_without_retry(keys, discovery, monkeypatch):
    entered = asyncio.Event()
    cancelled = []

    async def write(_arguments, _context):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.append(True)

    sdk = make_sdk(keys, discovery, mcp=provider(write=write))
    operation = asyncio.create_task(
        sdk.handlers.mcp(
            request(
                keys,
                "tools/call",
                {"name": "write", "arguments": {"title": "New"}},
                scopes=["read", "write"],
            )
        )
    )
    await asyncio.wait_for(entered.wait(), 2)
    operation.cancel()
    with pytest.raises(asyncio.CancelledError):
        await operation
    assert cancelled == [True]
    monkeypatch.setitem(MCP_LIMITS, "operationMs", 20)
    response = await sdk.handlers.mcp(
        request(
            keys,
            "tools/call",
            {"name": "write", "arguments": {"title": "New"}},
            scopes=["read", "write"],
        )
    )
    assert response.json_body()["error"]["code"] == -32603
    assert cancelled == [True, True]


async def test_sanitizes_handler_errors_and_validates_outputs(keys, discovery):
    async def fail(_arguments, _context):
        raise RuntimeError("private-secret")

    sdk = make_sdk(keys, discovery, mcp=provider(write=fail))
    response = await sdk.handlers.mcp(
        request(
            keys,
            "tools/call",
            {"name": "write", "arguments": {"title": "New"}},
            scopes=["read", "write"],
        )
    )
    assert "private-secret" not in response.text()
    assert response.json_body()["error"]["code"] == -32603


async def test_fastapi_native_route_and_http_regression(keys, discovery):
    from conftest import HOST
    from fastapi import FastAPI
    from test_adapters import options

    from weldall.adapters.fastapi import init_weldall

    sdk = init_weldall(
        HOST, {**options(keys, discovery), "supported_scopes": ["read", "write"], "mcp": provider()}
    )
    app = FastAPI()
    sdk.register_routes(app)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN) as client:
        rpc = request(keys)
        response = await client.post("/api/mcp", headers=rpc.headers.as_dict(), content=rpc.body)
        assert response.status_code == 200
        assert len(response.json()["result"]["tools"]) == 2
        assert (await client.get("/.well-known/oauth-protected-resource/api")).json()[
            "weldall_mcp"
        ]["endpoint"] == ENDPOINT
        assert (
            await client.post(
                "/api/mcp",
                headers={"content-type": "application/json"},
                content=b"x" * (MCP_LIMITS["requestBytes"] + 1),
            )
        ).status_code == 413
        assert (await client.post("/api/mcp", json={})).status_code == 401


async def test_typescript_streamable_http_client_against_python(keys, discovery):
    from test_interop import ROOT

    sdk = make_sdk(keys, discovery, mcp=provider())
    received = []

    async def serve(reader, writer):
        try:
            lines = (await reader.readuntil(b"\r\n\r\n")).decode().split("\r\n")
            method = lines[0].split(" ")[0]
            headers = dict(line.split(": ", 1) for line in lines[1:] if ": " in line)
            length = int(
                next((v for k, v in headers.items() if k.lower() == "content-length"), "0")
            )
            body = await reader.readexactly(length)
            if body:
                received.append(json.loads(body).get("method"))
            result = await sdk.handlers.mcp(Request(method, ENDPOINT, headers, body))
            output = {
                **result.headers.as_dict(),
                "content-length": str(len(result.body)),
                "connection": "close",
            }
            writer.write(
                (
                    f"HTTP/1.1 {result.status} Response\r\n"
                    + "".join(f"{k}: {v}\r\n" for k, v in output.items())
                    + "\r\n"
                ).encode()
                + result.body
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    async with server:
        process = await asyncio.create_subprocess_exec(
            "pnpm",
            "--silent",
            "exec",
            "tsx",
            "packages/sdk/test/fixtures/native-python-client.ts",
            cwd=ROOT,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        token = (
            request(keys, scopes=["read", "write"])
            .headers.get("authorization")
            .removeprefix("DPoP ")
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(
                    json.dumps(
                        {
                            "localEndpoint": f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}/api/mcp",
                            "publicEndpoint": ENDPOINT,
                            "token": token,
                            "device": keys.device,
                        }
                    ).encode()
                ),
                20,
            )
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
        assert process.returncode == 0, stderr.decode()
        assert json.loads(stdout) == {"ok": True}
        assert received == [
            "initialize",
            "notifications/initialized",
            "tools/list",
            "resources/list",
            "tools/call",
            "resources/read",
        ]


async def test_django_native_route(keys, discovery):
    from test_adapters import RequestFactory

    from weldall.adapters.django import DjangoWeldall

    sdk = DjangoWeldall(make_sdk(keys, discovery, mcp=provider()))
    route = next(pattern for pattern in sdk.urls() if pattern.name == "weldall-mcp")
    assert str(route.pattern) == "api/mcp"
    rpc = request(keys)
    incoming = RequestFactory().post(
        "/api/mcp",
        data=rpc.body,
        content_type="application/json",
        secure=True,
        HTTP_HOST="expenses.example",
        headers=rpc.headers.as_dict(),
    )
    response = await route.callback(incoming)
    assert response.status_code == 200
    assert len(json.loads(response.content)["result"]["tools"]) == 2
