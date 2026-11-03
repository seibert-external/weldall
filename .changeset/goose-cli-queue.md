---
"@weldall/goose": patch
---

Queue CLI calls beyond the four that run at once instead of failing them with `busy`; up to sixteen calls wait, and the wait counts toward the call's timeout.
