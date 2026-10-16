---
"@weldall/weldall": minor
"@weldall/cli": minor
---

Manage shared connections, group providers, and login providers through public-only IaC configuration and import existing connectors/providers without changing credentials. Add disabled drafts, UI-only credential provisioning, independent connection activation, dependency-safe lifecycle operations, and explicit plan-bound approval for login authority changes. Protect the last active login provider and reject incompatible snapshots from older clients. Bind login attempts to the provider's creation timestamp as well as its version, rejecting stale callbacks after provider recreation. Pending logins started before this upgrade must be restarted; existing sessions are unaffected. Apply server database migrations and restart with the regenerated Prisma client before upgrading the CLI.
