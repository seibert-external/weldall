---
"@weldall/weldall": patch
---

Cache validated MCP tool catalogs in bounded process-local memory for five minutes. Warm discovery avoids upstream sessions and warm calls skip repeated tool listing, while retaining live authorization, quotas, audit checks and fresh invocation sessions. Add safe phase timings and independently cancellable shared discovery.
