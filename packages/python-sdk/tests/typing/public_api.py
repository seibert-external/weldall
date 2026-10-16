"""Static consumer checks for the shipped public type surface."""

from typing import Any, assert_type

import httpx

from weldall import (
    AuthContext,
    CreateDpopProofInput,
    IdJagClaims,
    MachineAuthContext,
    MachineKey,
    MachineToken,
    MachineTokenRequestInput,
    PublishedSkill,
    Signing,
    SkillMcpDependency,
    SkillProvider,
    SkillVisibility,
    UserAuthContext,
    VerifyResult,
    WeldallMcpClient,
    WeldallOptions,
    create_dpop_proof,
    create_weldall_mcp_client,
    init_weldall,
    request_machine_token,
)
from weldall.adapters.django import DjangoWeldall
from weldall.adapters.fastapi import FastAPIWeldall


def narrow_auth(auth: AuthContext) -> None:
    if auth.identity_type == "user":
        assert_type(auth, UserAuthContext)
        assert_type(auth.email, str)
        assert_type(auth.identity.email, str)
    else:
        assert_type(auth, MachineAuthContext)
        assert_type(auth.identity.client_id, str)


def narrow_result(result: VerifyResult) -> None:
    if result.ok:
        assert_type(result.auth, AuthContext)
    else:
        assert_type(result.error.code, str)
        assert_type(result.response.status, int)


def typed_inputs(
    proof: CreateDpopProofInput,
    machine: MachineTokenRequestInput,
    signing: Signing,
    skills: SkillProvider,
    visibility: SkillVisibility,
    claims: IdJagClaims,
) -> None:
    assert_type(create_dpop_proof(proof), str)
    assert_type(request_machine_token(machine), MachineToken)
    assert_type(signing, Signing)
    assert_type(skills, SkillProvider)
    assert_type(visibility, SkillVisibility)
    assert_type(claims["urn:weldall:id-jag-draft"], str)


def typed_skill() -> PublishedSkill:
    dependency: SkillMcpDependency = {
        "connectorKey": "atlassian-mcp",
        "tools": ["search"],
        "includeResources": False,
    }
    return {
        "id": "recent",
        "title": "Recent issues",
        "content": "# Recent issues",
        "requiredScopes": [],
        "visibility": "DEFAULT",
        "mcpDependencies": [dependency],
    }


async def typed_mcp(key: MachineKey, http: httpx.AsyncClient) -> None:
    client = create_weldall_mcp_client(
        issuer="https://weldall.example.com", access_token="token", key=key, http_client=http
    )
    assert_type(client, WeldallMcpClient)
    assert_type(await client.list_connectors(), list[dict[str, Any]])
    assert_type(await client.list_connections(connector_key="work"), list[dict[str, Any]])
    assert_type(await client.list_tools(connector_key="work", connection="bot"), dict[str, Any])
    assert_type(await client.list_resources(connector_key="work", connection="bot"), dict[str, Any])
    assert_type(
        await client.call_tool(connector_key="work", connection="bot", name="read", arguments={}),
        dict[str, Any],
    )
    assert_type(
        await client.read_resource(connector_key="work", connection="bot", uri="fixture:///text"),
        dict[str, Any],
    )


def public_constructors(
    host: str,
    options: WeldallOptions,
) -> tuple[FastAPIWeldall, DjangoWeldall]:
    assert_type(init_weldall(host, options).issuer, str)
    return FastAPIWeldall(host, options), DjangoWeldall(init_weldall(host, options))
