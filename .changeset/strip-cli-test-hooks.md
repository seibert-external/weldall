---
"@weldall/cli": patch
---

Remove test-only credential, preferences, browser, HTTP bridge, and runtime hooks from published npm and standalone CLI artifacts. E2E coverage now uses explicitly instrumented test builds instead.
