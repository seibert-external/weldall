---
"@weldall/cli": minor
---

IaC manifests accept `agentDiscoveryEnabled` on a resource. It is sent only when it is `true`, so manifests without it keep their digest and keep working against servers that predate agent discovery.
