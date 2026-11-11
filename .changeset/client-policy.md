---
"@weldall/cli": minor
---

Add `weldall policy`, which prints the client policy that applies to the signed-in account and falls back to the last policy it loaded when the live load fails. `weldall status --json` gains a `policy` field, which is `null` when the server has no policy endpoint.
