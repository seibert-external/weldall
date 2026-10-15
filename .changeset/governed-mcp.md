---
"@weldall/sdk": minor
"@weldall/cli": minor
"@weldall/goose": minor
"@weldall/weldall": minor
---

Add governed remote MCP tools and resources through owner-managed connections: MCP connector and skill-dependency IaC, private DPoP APIs, runtime CLI commands, skill-driven Goose activation, and a separate public-client Atlassian MCP connector. Expose provider-derived HTTP/MCP capabilities in connector and connection metadata, with capability-aware CLI guidance and Goose activation. Hide MCP-dependent skills from user discovery and direct retrieval when a required connector is missing, disabled, non-MCP, or inaccessible, without requiring a personal connection or rejecting unresolved SDK catalog references. Record skill MCP dependencies in creation, update and deletion audits. Do not block unrelated IaC changes on retained dependencies that never resolved to MCP-capable connectors. Provider credentials remain server-side; no automatic tool-call replay. Deploy database migration 0018_mcp and update the server, CLI and Goose extension together for MCP workflows. Live Atlassian and Stock Goose release acceptance remains manual.
