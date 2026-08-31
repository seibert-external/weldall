---
"@weldall/cli": patch
---

Include the failed response body in `weldall request` errors: field errors from the facade (for example `sort: Invalid option: expected one of asc|desc`) now reach the agent instead of a bare `failed with HTTP 400` status line.
