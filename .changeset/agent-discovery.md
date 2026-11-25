---
"@weldall/weldall": minor
---

Resources can publish shared agents. A resource has a new switch, "Discover agents from this resource" (`agentDiscoveryEnabled`, off by default, independent of skill discovery). When it is on, Weldall reads the `weldall_agents_endpoint` named in the resource metadata with every catalog refresh (signed assertion of type `weldall-agents+jwt`, purpose `agents:read`, paged with `cursor`) and keeps a copy. The new `GET /api/me/agents` returns the agents the signed-in person owns or holds any one of the agent's scopes for; Weldall's own system scopes never open an agent. Existing resources are unaffected.
