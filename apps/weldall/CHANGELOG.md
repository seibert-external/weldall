# @weldall/weldall

## 0.2.0

### Minor Changes

- 0d18dd8: Add owner-managed Google connections for Gmail and Calendar, with encrypted server-side credential storage, administrator configuration through the UI and IaC, and CLI commands to connect, inspect, reconnect, disconnect, and proxy requests through Weldall.

  Existing CLI workflows, including connector-free IaC, remain compatible with servers that do not support connectors. Connector commands and connector IaC declarations require the updated server.

## 0.1.0

### Minor Changes

- 3d7f7b7: Version the Weldall server as a release unit. The app stays private on npm; `changeset publish` creates a `@weldall/weldall@x.y.z` Git tag and GitHub release, and the Docker image release builds from that tag.
