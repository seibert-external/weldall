import asyncio
import json

import httpx
import pytest
from test_interop import node

from weldall import create_weldall_mcp_client, generate_es256_key_pair, verify_strict_dpop
from weldall.mcp import MCP_LIMITS, WeldallMcpError, _validate

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def test_fresh_dpop_proof_and_safe_projection():
    key = generate_es256_key_pair()
    proofs = set()

    def handle(request):
        proof = verify_strict_dpop(
            request.headers["dpop"],
            method=request.method,
            url=str(request.url),
            replay="disabled",
            access_token="token",
            expected_jkt=key["jkt"],
        )
        assert proof.payload["jti"] not in proofs
        proofs.add(proof.payload["jti"])
        return httpx.Response(
            200, json={"content": [{"type": "text", "text": "ok", "_meta": {"ui": "discard"}}]}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        client = create_weldall_mcp_client(
            issuer="https://weldall.example.com", access_token="token", key=key, http_client=http
        )
        for _ in range(2):
            assert await client.call_tool(
                connector_key="atlassian", connection="production-bot", name="read", arguments={}
            ) == {"content": [{"type": "text", "text": "ok"}]}
    assert len(proofs) == 2


@pytest.mark.parametrize("status", [401, 403, 429, 502])
async def test_no_retry_or_error_body_leak(status):
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(status, text="private-secret")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        client = create_weldall_mcp_client(
            issuer="https://weldall.example.com",
            access_token="token",
            key=generate_es256_key_pair(),
            http_client=http,
        )
        with pytest.raises(WeldallMcpError) as failure:
            await client.call_tool(
                connector_key="atlassian", connection="bot", name="write", arguments={}
            )
        assert failure.value.status == status
        assert "private-secret" not in str(failure.value)
    assert len(requests) == 1


async def test_bounded_input_and_invalid_output():
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(200, json={"tools": "invalid"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        client = create_weldall_mcp_client(
            issuer="https://weldall.example.com",
            access_token="token",
            key=generate_es256_key_pair(),
            http_client=http,
        )
        with pytest.raises(WeldallMcpError, match="invalid_request"):
            await client.call_tool(
                connector_key="atlassian",
                connection="bot",
                name="write",
                arguments={"text": "x" * MCP_LIMITS["requestBytes"]},
            )
        assert requests == []
        with pytest.raises(WeldallMcpError, match="invalid_response"):
            await client.list_tools(connector_key="atlassian", connection="bot")
    assert len(requests) == 1


async def test_total_deadline_interrupts_slow_headers(monkeypatch):
    monkeypatch.setitem(MCP_LIMITS, "discoveryMs", 100)
    requests = 0
    handlers = []

    async def respond(reader, writer):
        nonlocal requests
        handlers.append(asyncio.current_task())
        requests += 1
        try:
            await reader.readuntil(b"\r\n\r\n")
            writer.write(b"HTTP/1.1 200 OK\r\n")
            for _ in range(30):
                writer.write(b"X-Slow: yes\r\n")
                await writer.drain()
                await asyncio.sleep(0.02)
            writer.write(b"Content-Length: 2\r\n\r\n[]")
            await writer.drain()
        except ConnectionError:
            pass
        finally:
            writer.close()

    server = await asyncio.start_server(respond, "127.0.0.1", 0)
    try:
        async with server, httpx.AsyncClient(trust_env=False) as http:
            port = server.sockets[0].getsockname()[1]
            client = create_weldall_mcp_client(
                issuer=f"http://127.0.0.1:{port}",
                access_token="token",
                key=generate_es256_key_pair(),
                http_client=http,
            )
            start = asyncio.get_running_loop().time()
            with pytest.raises(WeldallMcpError, match="timeout"):
                await asyncio.wait_for(client.list_connectors(), timeout=1)
            assert asyncio.get_running_loop().time() - start < 0.4
            assert requests == 1
    finally:
        for task in handlers:
            task.cancel()
        await asyncio.gather(*handlers, return_exceptions=True)


@pytest.mark.parametrize("cancel", [False, True])
async def test_stalled_body_is_closed_on_deadline_or_cancellation(monkeypatch, cancel):
    monkeypatch.setitem(MCP_LIMITS, "operationMs", 100 if not cancel else 10000)
    reading = asyncio.Event()
    closed = False
    requests = 0

    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):
            reading.set()
            await asyncio.Event().wait()
            yield b"{}"

        async def aclose(self):
            nonlocal closed
            closed = True

    async def handle(request):
        nonlocal requests
        requests += 1
        return httpx.Response(200, stream=Body())

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        client = create_weldall_mcp_client(
            issuer="https://weldall.example.com",
            access_token="token",
            key=generate_es256_key_pair(),
            http_client=http,
        )
        task = asyncio.create_task(
            client.call_tool(
                connector_key="atlassian",
                connection="bot",
                name="write",
                arguments={},
            )
        )
        await asyncio.wait_for(reading.wait(), timeout=1)
        if cancel:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            with pytest.raises(WeldallMcpError, match="timeout"):
                await asyncio.wait_for(task, timeout=1)
        assert closed
        assert requests == 1


@pytest.mark.parametrize(
    ("kind", "value"),
    [
        (
            "tools",
            {
                "tools": [
                    {"name": "read", "inputSchema": {"type": "object"}, "_meta": {"ui": "drop"}}
                ]
            },
        ),
        (
            "call",
            {
                "content": [{"type": "text", "text": "ok", "extra": "drop"}],
                "structuredContent": {"nested": [1, True]},
            },
        ),
        (
            "tools",
            {"tools": [{"name": "read", "title": "😀" * 129, "inputSchema": {"type": "object"}}]},
        ),
        (
            "connections",
            [
                {
                    "id": "id",
                    "key": "bot",
                    "accessMode": "SCOPED",
                    "connectorKey": "atlassian",
                    "name": "😀" * 90,
                    "accountName": "Service",
                    "status": "DISABLED",
                    "connectorEnabled": True,
                    "capabilities": ["mcp"],
                    "useScopes": ["jira:shared"],
                }
            ],
        ),
        ("read-resource", {"contents": [{"uri": "fixture:///blob", "blob": "AAECAw=="}]}),
        ("read-resource", {"contents": [{"uri": "not a uri", "text": "bad"}]}),
        ("call", {"content": [{"type": "image", "data": "invalid", "mimeType": "image/png"}]}),
        (
            "call",
            {"content": [{"type": "text", "text": "ok"}], "structuredContent": {"__proto__": {}}},
        ),
        (
            "connections",
            [
                {
                    "id": "id",
                    "key": "bot",
                    "accessMode": "SCOPED",
                    "connectorKey": "atlassian",
                    "name": "Bot",
                    "accountName": "Service",
                    "status": "READY",
                    "connectorEnabled": True,
                    "capabilities": ["mcp"],
                    "useScopes": [],
                }
            ],
        ),
    ],
)
def test_shared_typescript_python_contracts(kind, value):
    expected = node("mcp-contract", {"kind": kind, "value": value})
    try:
        result = {"valid": True, "value": _validate(kind, value, MCP_LIMITS["resultBytes"])}
    except Exception:
        result = {"valid": False}
    assert result == expected, json.dumps(value)
