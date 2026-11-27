---
"@weldall/cli": minor
---

`weldall apps` lists the apps the signed-in person owns or that are shared with a permission they hold: one line per app with its ID, name, link, owner, repository, the scopes it is shared with, its creation date, and its review date (`review by`, or `review due since` once it has passed; a flag only), followed by a line with its purpose (`--json` for the full entries). A server that predates app discovery is reported as such.

IaC manifests accept `appDiscoveryEnabled` on a resource. It is sent only when it is `true`, so manifests without it keep their digest and keep working against servers that predate app discovery.
