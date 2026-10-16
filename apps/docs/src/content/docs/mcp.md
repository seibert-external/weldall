---
title: MCP
description: Configuration and usage reference for remote MCP connections.
---

Weldall brokers remote MCP tools and resources over Streamable HTTP. Clients use its private DPoP-protected JSON API; provider credentials remain encrypted server-side. This is not a public MCP endpoint.

## Configure a connector

Create an **Atlassian MCP** connector in **Admin → Connectors**, or add this to an existing IaC manifest:

```yaml
connectors:
  atlassian_mcp:
    key: atlassian-mcp
    name: Atlassian MCP
    type: atlassian-mcp
    enabled: true
    envelopeProvider: LOCAL_ENV
    requiredScopes: [] # All login-authorized users; set scopes to restrict access.
    provider:
      allowedScopes: [read:jira:agent-interface, search:jira:agent-interface]
      defaultScopes: [read:jira:agent-interface, search:jira:agent-interface]
```

The fixed endpoint is `https://mcp.atlassian.com/v2/mcp`. No endpoint, OAuth client ID or application secret is entered. `envelopeProvider` (`LOCAL_ENV` or `OPENBAO`) is immutable; OpenBao errors never fall back to local encryption. Atlassian REST connections are separate and cannot be reused. IaC apply does not register an OAuth client or request consent; remove skill dependencies before disabling/deleting their connector.

## Connect Atlassian MCP

```sh
weldall connections connect atlassian-mcp --name my-atlassian-mcp
weldall connections show my-atlassian-mcp
```

The first connection registers a public OAuth client using PKCE S256 and `token_endpoint_auth_method: none`. Callback: `https://weldall.example.com/api/connectors/atlassian-mcp/callback`, with your Weldall origin. `read:me`, `read:account` and `offline_access` accompany the selected MCP permissions.

Tokens are site-bound and represent an Atlassian system account, not necessarily the signed-in person. Connection details show the cloud ID and selected/granted scopes. Reduced grants are accepted; missing permissions may make tools unavailable. Refresh uses provider-reported expiry, retains previous scopes if omitted, and rejects unrequested scopes or account/site changes. Reconnect when required.

Registration is coordinated across workers; a concurrent request may report it in progress. Failed/interrupted registration is not retried automatically. An administrator must investigate before deliberately recreating the connector and dependent configuration; a changed callback origin also needs this recovery. Disconnecting locally does not replace upstream revocation in Atlassian's connected-app settings.

## Shared service-account connections

Under **Admin → Connections → Add shared connection**, choose an Atlassian MCP connector, a globally unique immutable identifier, a display name and at least one existing non-system use scope. The identifier selects the connection; it is **not the token**. Provision an **Atlassian service-account API key using Bearer authentication**, not a personal Basic token or shared OAuth grant. The Atlassian organization must permit API-token authentication.

- Callers need **all connector required scopes and all connection use scopes**, including administrators and credential managers. Personal OAuth remains owner-only; access mode and identifier cannot change. Display names may repeat.
- Atlassian controls token permissions; Weldall does not inspect them. Optional cloud IDs are metadata, never injected into arguments. Some tools require OAuth; API-key calls may require an explicit `cloudId`.
- Disabled drafts need no credential. Provisioning/rotation does not enable them. Both connector and connection must be enabled; disabling preserves the token. The detail view supports version-checked scope edits, rotation and deletion. **Reconnect required** is a credential error, not something the enable toggle clears. Rotate before expiry and revoke keys separately in Atlassian.
- [IaC](../infrastructure-as-code/#public-configuration-ui-only-credentials) manages public configuration/import, never secrets. Scope replacements can be applied atomically with managed connections; references outside the workspace block deletion. A connection must retain a nonempty scope list. Deletion removes its own scope links and encrypted credential, not upstream access.

### Machine SDK use

Assign `weldall:mcp` plus all connector/use scopes and request a DPoP token for Weldall's own resource (`https://weldall.example.com/api`). Use `createWeldallMcpClient` ([TypeScript example](https://github.com/seibert-external/weldall/blob/main/packages/sdk/README.md#call-shared-mcp-connections-as-a-machine)) or `create_weldall_mcp_client` ([Python example](https://github.com/seibert-external/weldall/blob/main/packages/python-sdk/README.md#call-shared-mcp-connections-as-a-machine)) with the stable connection key. There is no CLI machine mode, machine OAuth setup or runtime secret provisioning.

Discovery returns only accessible shared connections. Each request gets a fresh proof and intersects token scopes with current assignments; scope/key revocation and machine disablement block subsequent dispatch. SDK requests are bounded and never retried. Python MCP methods require `await`; SDK-specific cancellation and timeout details are in the linked references.

## CLI operations

```sh
weldall mcp list --json
weldall mcp tools atlassian-mcp --connection my-atlassian-mcp --json
weldall mcp resources atlassian-mcp --connection my-atlassian-mcp --json
weldall mcp call atlassian-mcp TOOL_NAME --connection my-atlassian-mcp --arguments '{}' --json
weldall mcp read-resource atlassian-mcp --connection my-atlassian-mcp --uri 'RESOURCE_URI' --json
```

Use discovered tool names, arguments and resource URIs. JSON preserves supported content blocks, structured content, business errors and text/blob resources, but not arbitrary upstream extensions or MCP Apps metadata. Every request rechecks authorization, readiness, grants, quota and configuration. Never automatically retry a failed call: it may already have executed.

## Skills and agent hosts

IaC skills and SDK catalogs can declare:

```yaml
mcpDependencies:
  - connectorKey: atlassian-mcp
    tools: [getJiraIssue] # Verify the name with mcp tools.
    includeResources: false
```

Dependencies select context, **not permissions or tool allowlists**. SDK catalogs may reference connectors/scopes before they exist without provisioning them. MCP-dependent skills are visible/retrievable only when every connector exists, is enabled, has `capabilities: ["mcp"]` and permits the caller. A missing personal connection does not hide a skill; unknown required scopes do. This also applies to resource-published skills, regardless of visibility settings.

Hosts using Weldall's local MCP extension need list-change notification support. `read_skill_document` activates declared tools/resources only, with explicit MCP capabilities on connector and connection. One compatible READY personal/shared connection is selected automatically; multiple accounts require a user choice via `select_mcp_connection` using an offered ID. Missing connections require setup; ambiguous names are rejected. At the 200-connection catalog limit, selection must be explicit. Selection cannot change the skill's tool list or the account bound for that session; start a new session to switch accounts.

Activation is cumulative and preserves existing tools. Use advertised `mcp_<connector-key hash>__upstreamName` names and session-local `weldall-mcp://` resource URIs, not constructed URLs. Only exposed URIs can be read; each invocation goes through the local CLI and is reauthorized server-side.

## Boundaries and rollout

- Follow the [migration/server/client rollout order](../infrastructure-as-code/#rollout-and-compatibility), including `0021_iac_secret_primitives`. Update the local MCP extension with the server/CLI; older HTTP-only workflows remain supported. Validate live Atlassian authorization and host behavior in your environment; fixture tests do not establish that compatibility.
- Per skill: at most 8 connectors and 32 tools per connector. Discovery: at most 100 tools/resources, 20 pages and 1 MiB of definitions. Results: 10 MiB. The local extension limits CLI arguments to 24,000 characters.
- Only reviewed canonical HTTPS endpoints with public IPv4 targets are supported. DNS pinning and TLS hostname verification apply; redirects, private targets, proxy forwarding, automatic invocation recovery and session resumption are disabled.
- Audits contain identifiers, outcomes, timing and resource fingerprints, not arguments, contents or credentials.
- No public northbound MCP endpoint, prompts, resource templates/subscriptions, MCP Apps or per-tool authorization policy.
