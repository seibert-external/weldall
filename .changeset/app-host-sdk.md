---
"@weldall/sdk": minor
---

Add the app host contract for a Git app registered as a Weldall resource: request and response schemas for Weldall's `/api/app-host/v1` endpoints (app registry entries and Git audit event reports) and for `check-scopes`, the scope constants `APP_HOST_SCOPE`, `SUBJECT_SCOPES_CHECK_SCOPE` and `LOGIN_SCOPE`, and `createWeldallAppHostClient`, a small machine client for these endpoints. Additive; nothing existing changes.
