---
"@weldall/weldall": patch
---

Fix server authentication issues involving profile images and OAuth client registration. Update Next.js, sharp, and Zod in the server image.

**Upgrading from 0.9.0 or earlier:** Existing records are not cleaned up automatically. Before restoring traffic, clear cached avatar URLs you can't verify and disable untrusted user-owned OAuth clients. Fresh installs need no action.
