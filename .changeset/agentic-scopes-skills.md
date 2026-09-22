---
"@weldall/cli": minor
---

Add `--agentic` to `scopes`, `skills show`, and `skills find`, alongside `skills list`. The output is TOON: `scopes` declares the assigned scopes inline and one row per resource, `skills show` writes one object and drops the duplicated skill body along with the fields an agent does not act on, and `skills find` writes a table of exactly what the local cache holds. As on `skills list`, the shape is not a contract and `--json` cannot be combined with it.
