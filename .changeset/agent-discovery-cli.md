---
"@weldall/cli": minor
---

`weldall agents` lists the shared agents the signed-in person owns or that are shared with a permission they hold (`--json` for the full entries). A server that predates agent discovery is reported as such.

IaC manifests accept `agentDiscoveryEnabled` on a resource. It is sent only when it is `true`, so manifests without it keep their digest and keep working against servers that predate agent discovery.
