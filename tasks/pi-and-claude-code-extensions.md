# Pi and Claude Code extensions

## Goal

Provide supported integrations for Pi and Claude Code so agents can discover Weldall-provided instructions and use the existing Weldall CLI without users manually copying configuration between tools.

## Scope

- Build installable integrations for both Pi and Claude Code using each product's supported extension/plugin mechanism.
- Share a small common integration layer where practical while keeping host-specific packaging and lifecycle code separate.
- Surface the active Weldall issuer, signed-in identity, assigned scopes, available skills, and actionable authentication errors.
- Make Weldall skill documents available to the agent with their source, required scopes, availability, and last-update metadata preserved.
- Route authenticated API operations through the existing `weldall` CLI and its DPoP/session controls rather than reading credentials or private keys from extension code.
- Preserve each host's tool approval and permission model; do not silently broaden shell, network, or filesystem access.
- Refresh cached organization instructions and skills predictably after login, logout, issuer changes, and assignment changes.
- Document installation, updates, removal, supported host versions, and troubleshooting for both integrations.

## Acceptance criteria

- A clean Pi installation and a clean Claude Code installation can install their respective integration using documented steps.
- In both hosts, an authenticated user can list scopes, discover available Weldall skills, load one skill, and perform an approved request through the CLI.
- Logged-out, expired-session, unavailable-scope, and unreachable-server states produce clear recovery instructions.
- Extension logs and diagnostics never contain refresh tokens, access tokens, DPoP private keys, or complete authorization headers.
- Shared contract tests keep the two integrations behaviorally aligned, with host-specific smoke tests covering installation and one end-to-end request.
