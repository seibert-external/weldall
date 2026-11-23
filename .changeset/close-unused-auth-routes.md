---
"@weldall/weldall": patch
---

Limit the server's public Better Auth routes to those used by Weldall. Update Next.js, its sharp image dependency, and Zod in the server image.

**Upgrading from 0.9.0 or earlier:** The allowlist prevents new user-set avatar URLs and self-registered OAuth clients, but existing records remain in use. Before restoring traffic, review cached avatars and user-owned clients and clear or disable untrusted entries. There is no automatic cleanup. Fresh installs need no action.
