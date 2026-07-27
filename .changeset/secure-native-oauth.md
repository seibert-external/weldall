---
"@weldall/cli": patch
"@weldall/sdk": patch
---

Require explicit approval for every native CLI login, make cross-process credential locking race-safe, and preserve rotated refresh credentials before follow-up validation.

Harden SDK error responses, authorization-server metadata, replay classification, request-target matching, and published security guidance.
