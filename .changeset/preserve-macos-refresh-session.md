---
"@weldall/cli": patch
---

Preserve the existing macOS Keychain item during token refresh and profile updates, avoiding session loss when an update fails or is interrupted. Keep explicit login ownership migration and separate npm/standalone credential namespaces unchanged.
