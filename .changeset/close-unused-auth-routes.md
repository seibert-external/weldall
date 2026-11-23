---
"@weldall/weldall": patch
---

Limit the server's public Better Auth routes to those used by Weldall. On upgrade, disable previously self-registered OAuth clients and clear cached profile images; the group provider supplies avatars again on the next membership lookup. Update Next.js, its sharp image dependency, and Zod in the server image.
