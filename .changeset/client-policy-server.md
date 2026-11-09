---
"@weldall/weldall": minor
---

Group assignments and the CLI settings can now carry a client policy. A policy sets the approval mode, extensions, shell access and allowed models, and a group policy can add instructions. Set it with IaC under `groupAssignments.<name>.policy` and `cli.policy`. The new `GET /api/me/policy` endpoint returns the caller's merged policy, and `GET /api/me/cli` appends the caller's group instructions to the organisation appendix.
