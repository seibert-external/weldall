# @weldall/weldall

## 0.5.2

### Patch Changes

- 667628f: Keep managed connections usable when an upstream endpoint rejects a request with HTTP 401, add safe Atlassian diagnostics, and support selectable granular scopes for every Jira, Jira Software, Jira Service Management, and Confluence route accepted by the connector.

## 0.5.1

### Patch Changes

- aa02432: Publish the Weldall server as a Docker image. Each `@weldall/weldall` release is now built, tested against a clean PostgreSQL, and published to Docker Hub as `x.y.z`, `x.y`, `latest` and the commit SHA.

## 0.5.0

### Minor Changes

- 5bf763c: Add Atlassian Cloud connectors for Jira and Confluence, with mandatory site allowlists, resource-level OAuth setup, and rotating offline credentials. Support Atlassian connector policy in IaC and provider-owned site metadata in connection details. Show provider-generated request examples and pagination guidance in human, JSON, and agent-oriented CLI output. Allow local cancellation cleanup when a provider does not support remote revocation, with an explicit warning.

## 0.4.0

### Minor Changes

- be0d54f: Add a read-only `/statistics` page for anyone holding the new system scope `weldall:statistics`. It shows org-wide usage over the last 24 hours, 7, 30 or 90 days: active people with the change from the previous period, token exchanges by resource, the people who retrieved each skill and the number of machine clients. `weldall:administer` does not include the scope, and the page remembers the last interval in a cookie.

## 0.3.0

### Minor Changes

- eecb200: Support OpenBao Transit envelope encryption for managed connectors and accept OPENBAO in declarative manifests. Keep OpenBao availability scoped to credential operations rather than administration or startup.

## 0.2.0

### Minor Changes

- 0d18dd8: Add owner-managed Google connections for Gmail and Calendar, with encrypted server-side credential storage, administrator configuration through the UI and IaC, and CLI commands to connect, inspect, reconnect, disconnect, and proxy requests through Weldall.

  Existing CLI workflows, including connector-free IaC, remain compatible with servers that do not support connectors. Connector commands and connector IaC declarations require the updated server.

## 0.1.0

### Minor Changes

- 3d7f7b7: Version the Weldall server as a release unit. The app stays private on npm; `changeset publish` creates a `@weldall/weldall@x.y.z` Git tag and GitHub release, and the Docker image release builds from that tag.
