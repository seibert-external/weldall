---
"@weldall/weldall": minor
"@weldall/cli": minor
---

Add public-only IaC configuration/import for shared connections and group/login providers, with UI-only credentials, disabled drafts and plan-bound login-authority approval. Preserve credentials during import and protect the last active login provider. Back up the database and deploy migrations with the matching server before updating clients. An unfinished sign-in from before the upgrade must be started again; existing sessions remain valid.
