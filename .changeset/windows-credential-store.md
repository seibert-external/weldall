---
"@weldall/cli": patch
---

Fix `weldall login` on Windows: store the session as UTF-8 bytes so it fits the 2560-byte Credential Manager limit.
