---
"@weldall/weldall": minor
---

Resources can publish shared agents next to their skill catalog. A resource with skill discovery switched on may name a `weldall_agents_endpoint` in its resource metadata; Weldall reads it with every catalog refresh (signed assertion of type `weldall-agents+jwt`, purpose `agents:read`, paged with `cursor`) and keeps a copy. The new `GET /api/me/agents` returns the agents the signed-in person owns or holds any one of the agent's scopes for. A resource without the endpoint is unaffected.
