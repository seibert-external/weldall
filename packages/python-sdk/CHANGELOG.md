# Changelog

## Unreleased

- Add native stateless MCP serving with scoped user/machine authentication, immutable catalogs, async handlers and FastAPI/Django routing. Add whole-resource and connector-type skill dependencies. Full Task 1 parity and host acceptance remain pending; this is not a release announcement.
- Add async `create_weldall_mcp_client` for shared connections and `SkillMcpDependency` for skill catalogs, matching TypeScript contracts. Calls use DPoP, bounded deadlines and sanitized errors, with no automatic retries.

## 0.1.0

- Initial Python SDK with framework-neutral, FastAPI, and Django integrations.
