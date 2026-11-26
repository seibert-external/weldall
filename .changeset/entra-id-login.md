---
"@weldall/weldall": minor
---

Sign in with Microsoft Entra ID: a login provider with a tenant-bound Entra ID v2.0 issuer now accepts members of that tenant whose email Entra ID marks as verified with the `xms_edov` claim, and rejects guest accounts. The login page, the provider test and the installer explain these rejections instead of showing the generic error. Setup is described in the new Entra ID guide.
