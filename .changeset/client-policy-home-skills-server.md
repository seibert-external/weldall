---
"@weldall/weldall": minor
---

Client policies can set `homeSkills`, and the default policy (`cli.policy`) can set `modelKey`. `GET /api/me/policy` serves every group's pins in group order, then the default's, without duplicates, and the default's `modelKey` as is.
