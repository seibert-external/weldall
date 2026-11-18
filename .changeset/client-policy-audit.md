---
"@weldall/weldall": minor
---

Every change to a client policy, on a group assignment or the default in the `cli` block, now writes a `client_policy.updated` audit event. It records which fields changed and SHA-256 digests of the old and new policy, never the policy content.
