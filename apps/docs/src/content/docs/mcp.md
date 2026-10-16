---
title: Governed MCP
description: Use remote MCP tools and resources through personal or scope-shared Weldall connections.
---

Weldall brokers remote MCP tools and resources over Streamable HTTP. Your CLI talks only to Weldall's private DPoP-protected JSON API; provider credentials stay encrypted on the server. In Goose, the published `@weldall/goose` extension remains the MCP server.

## Configure a connector

Create an **Atlassian MCP** connector in the existing admin connector screen, or use IaC below. This is one connector with personal and shared connections beneath it; there is no separate MCP-server configuration. The provider supplies the fixed endpoint `https://mcp.atlassian.com/v2/mcp`, so admins do not enter an endpoint, OAuth client ID, or client secret. Choose the credential encryption provider when creating the connector (`LOCAL_ENV` or `OPENBAO`); it cannot be changed later. OpenBao failures never fall back to local encryption.

Add this connector to your existing `weldall.dev/v1` manifest:

```yaml
connectors:
  atlassian_mcp:
    key: atlassian-mcp
    name: Atlassian (MCP)
    type: atlassian-mcp
    enabled: true
    envelopeProvider: LOCAL_ENV
    requiredScopes: [] # Every login-authorized user; set your Weldall scopes to restrict access.
    provider:
      allowedScopes: [read:jira:agent-interface, search:jira:agent-interface]
      defaultScopes: [read:jira:agent-interface, search:jira:agent-interface]
```

Use the existing IaC plan/apply workflow. Plans validate skill dependencies on enabled MCP connectors; remove dependencies before deleting or disabling their targets. Applying this configuration does not register an OAuth client or request user consent.

## Connect Atlassian MCP

This is separate from the Atlassian REST connector: existing REST grants are not reused.

```sh
weldall connections connect atlassian-mcp --name my-atlassian-mcp
weldall connections show my-atlassian-mcp
```

The first authorization lazily registers a public client with Atlassian. Registering uses the callback `https://weldall.example.com/api/connectors/atlassian-mcp/callback` with your Weldall origin. Authorization uses PKCE S256 and `token_endpoint_auth_method: none`; no application secret is required or retained. `read:me`, `read:account`, and `offline_access` are required alongside the selected MCP permissions.

Atlassian may grant fewer scopes than requested. Weldall accepts and records that reduced grant, logs the missing scopes, and shows selected versus granted scopes in connection details. Refresh may also reduce scopes; if its response omits scopes, Weldall retains the previous granted set. Unrequested scopes and changes to the account or site on refresh are still rejected. Tools requiring missing permissions may be unavailable or denied by Atlassian.

The access token is site-bound and represents an Atlassian system account, not necessarily the human signed into Weldall. Connection details show the site cloud ID. Access-token expiry comes from the token response (currently 28,800 seconds); refresh runs through the existing encrypted connection lifecycle. Refresh tokens are approximately 90 days, subject to Atlassian policy and revocation; reconnect when required.

Registration is connector-owned and coordinated across workers. A competing first request can report registration in progress. A failed or interrupted registration is **not retried automatically**: an administrator must investigate and explicitly remove/recreate the connector and its dependent configuration if a new registration is appropriate. Changing the callback origin also requires deliberate registration recovery. Disconnect removes local access; finish upstream revocation in Atlassian's connected-app settings when instructed.

## Shared service-account connections

In **Admin → Connections → Add shared connection**, choose an enabled Atlassian MCP connector.
Enter an immutable, globally unique connection identifier (for example `atlassian-production-bot`),
a display name, secret API token, and at least one existing Weldall use scope.
The identifier is a public name apps and SDKs use to select the connection, **not the token**.
This uses an Atlassian **service-account API key with Bearer authentication**, never a personal
Basic API token or another person's OAuth grant. The Atlassian organization must allow API-token
authentication; Weldall does not require a confirmation checkbox.

Token permissions are managed in Atlassian; no additional permission declaration is needed in
Weldall, and Weldall does not inspect those permissions. Weldall use scopes control who can use
the connection, not the token's Atlassian permissions. Optional cloud IDs are metadata and are
never inserted into tool arguments. Some tools require OAuth; others require an explicit `cloudId`
argument with API keys.

Every caller must hold **all connector required scopes and all connection use scopes**.
Administrators and credential managers have no invocation bypass. Personal OAuth remains
owner-only. Use the Personal/Shared list filter; the detail page supports version-checked
scope edits, API-key rotation, disablement and deletion. Access mode and shared key cannot
be changed. Rotate before expiry. Disabling sets the connection to **Disabled** and blocks
all calls while retaining the encrypted token. **Enable connection** restores local access;
rotating a token while disabled does not enable the connection. **Reconnect required** is a
separate credential-error state and cannot be cleared by this toggle. Deleting or
disabling in Weldall does not revoke the key upstream—revoke it in Atlassian administration.

IaC continues to manage scopes and their user/group/machine assignments. Shared credentials
are operational objects, not IaC primitives; never place API keys in manifests or state.
A referenced scope cannot be deleted: replace its use scopes or delete the shared connection
in the UI **before** a separate IaC apply removes the scope. The last use scope cannot be
removed, and deleting a connection removes only its own join rows and encrypted credential.

### Machine SDK use

Machines use the TypeScript or Python SDK, not a CLI `--machine` mode. Assign `weldall:mcp`
plus every connector/use scope to the machine, then request a DPoP token for Weldall's own
resource (`https://weldall.example.com/api`):

```ts
import { requestMachineToken, createWeldallMcpClient } from "@weldall/sdk";

const token = await requestMachineToken({
  issuer,
  clientId,
  kid,
  key,
  resource: weldallResource,
  scopes: ["weldall:mcp", "atlassian-mcp:use-shared"],
});
const mcp = createWeldallMcpClient({ issuer, accessToken: token.accessToken, key });
await mcp.listConnections({ connectorKey: "atlassian-mcp" });
await mcp.callTool({
  connectorKey: "atlassian-mcp",
  connection: "atlassian-production-bot",
  name: "getJiraIssue",
  arguments: { cloudId, issueIdOrKey: "OPS-123" },
});
```

Machine discovery returns only accessible shared connections. Each request has a fresh
DPoP proof and uses the intersection of token scopes and current assignments. Revoking
a scope/key or disabling the machine blocks subsequent dispatch, including a connection
already selected in Goose. SDKs validate bounded shared contracts and never retry calls.
No runtime API provisions secrets or starts OAuth for machines. Python MCP methods are async:
use `await` for each call; their total deadline covers connection setup, headers and body reads.

## CLI operations

```sh
weldall mcp list --json
weldall mcp tools atlassian-mcp --connection my-atlassian-mcp --json
weldall mcp resources atlassian-mcp --connection my-atlassian-mcp --json
weldall mcp call atlassian-mcp TOOL_NAME --connection my-atlassian-mcp --arguments '{}' --json
weldall mcp read-resource atlassian-mcp --connection my-atlassian-mcp --uri 'RESOURCE_URI' --json
```

Replace `TOOL_NAME`, arguments, and `RESOURCE_URI` with the exact discovered values. JSON output preserves supported content blocks, structured content, business errors, and text/blob resource contents. Arbitrary upstream extensions, including MCP Apps metadata, are not forwarded.

Every operation rechecks owner or scope authorization, connector access, connection readiness, grants, quota and current configuration. All upstream tools are callable with a valid connection; skill declarations are **context selection, not permission grants or tool allowlists**. Never automatically retry a failed call: execution may already have happened.

## Skill-driven Goose activation

Add `mcpDependencies` to an IaC skill or SDK skill-catalog entry:

```yaml
mcpDependencies:
  - connectorKey: atlassian-mcp
    tools: [getJiraIssue] # Example only: verify the exact name with mcp tools.
    includeResources: false
```

Connector and connection metadata declare `capabilities: ["mcp"]`. Goose checks this field rather than provider names; `weldall mcp list --json` is the capability-filtered connector catalog. Actual tools still come from live discovery for the selected account.

SDK catalogs may reference scopes and connectors before they exist; those references are stored without provisioning anything. Skills with MCP dependencies appear in the user catalog and can be retrieved directly only when every referenced connector exists, is enabled, supports MCP, and permits the caller's scopes. This applies to both manually configured and resource-published skills, regardless of their visibility setting. A missing personal connection does not hide a skill. Published skills with unknown required scopes remain hidden until those scopes are registered.

Loading the skill through `read_skill_document` activates only its declared tools. Personal and accessible shared connections are candidates. One compatible READY connection is selected automatically; multiple accounts require an explicit user choice via `select_mcp_connection` using an ID from the offered choices; no account produces a connection-required status. Display names may repeat; ambiguous names are rejected. The model cannot substitute a different tool list during selection. If the existing connection catalog reaches its 200-entry cap, Goose does not infer uniqueness and requires explicit selection from the visible accounts. Each connector is bound to one account for the session; start a new session to switch accounts.

Tool names use `mcp_<connector-key hash>__upstreamName`, keeping namespaces distinct and bounded even for long connector keys. Use the names advertised by the extension rather than constructing them. Resources and returned resource links use session-local `weldall-mcp://` URIs; only URIs actually exposed in that session can be read. Activation is cumulative and emits tool/resource list-change notifications. The original six tools remain available.

## Persistence and migration

Migration `0018_mcp` introduces MCP without changing existing applied migration history.
Migration `0019_shared_mcp_connections` adds shared connections without resetting configuration.
Migration `0020_connection_disabled_status` adds the distinct disabled state without rewriting existing statuses.
Existing connections default to `ConnectionAccessMode.OWNER_ONLY` with a null key. Shared rows use `SCOPED`
and a globally unique key; `ConnectionUseScope(connectionId, scopeId)` stores the all-of
requirements relationally. Deleting a connection cascades its join rows, while deleting a
referenced scope is restricted. Personal names remain owner-unique through a partial index;
shared display names need not be unique. Mutation services enforce nonempty non-system
use scopes and immutable access mode/key; API metadata projects sorted scope keys.

## Boundaries and rollout

- Deploy migrations through `0020_connection_disabled_status` before running the updated server. Update the CLI and Goose extension together for MCP workflows; older non-MCP workflows remain supported.
- Maximum 8 connector dependencies and 32 declared tools per connector per skill; discovery permits 100 tools/resources over at most 20 pages and 1 MiB of definitions. Results are capped at 10 MiB. Goose also applies a 24,000-character CLI argument budget.
- Remote endpoints require canonical HTTPS, reviewed provider compatibility and public IPv4 DNS. Requests are DNS-pinned with TLS hostname verification; redirects, private targets, proxy forwarding, automatic invocation recovery and session resumption are disabled.
- Configuration and operation audits store identifiers, outcomes, timing and resource fingerprints—not arguments, content or credentials.
- No public northbound MCP endpoint, prompts, resource templates/subscriptions, MCP Apps, or per-tool authorization policy is provided.
- Automated fixture/package checks are not live Atlassian or Stock Goose acceptance. Verify those in your own environment before rollout; no live OAuth or Docker/E2E run is required by the local unit-test workflow.
