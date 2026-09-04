---
"@weldall/sdk": minor
---

Extend `@weldall/sdk/starlight` with a protected `GET /api/content` endpoint (configurable via `contentPath`, default `/api/content`) that returns full page markdown as `{ path, title, description, content, subject }`, with raw bodies persisted to `.weldall-search/documents.json` at build and copied into the build output. Also allow site owners to customize the generated `search` skill via `weldallSearch(host, { skills: { search: { title?, content?, extraRules? } } })`, with overrides persisted to `.weldall-search/config.json`. The generated skill now documents both the search and page-read commands and their response shapes.
