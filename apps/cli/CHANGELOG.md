# @weldall/cli

## 0.11.2

### Patch Changes

- 1932dd0: Include the failed response body in `weldall request` errors: field errors from the facade (for example `sort: Invalid option: expected one of asc|desc`) now reach the agent instead of a bare `failed with HTTP 400` status line.

## 0.11.1

### Patch Changes

- f96499e: Add a once-daily, stderr-only notice when a newer `@weldall/cli` version is available, with the upgrade command matching your install method (npm or standalone).

## 0.11.0

### Minor Changes

- 4f9a993: Make help strictly local, cache validated discovery and signing keys, reuse verified access sessions, prepare resource authorization once per process, add bounded offset pagination with JSON Lines output, and add cached skill search and positional skill aliases.

## 0.10.0

### Minor Changes

- 2ae041c: Support the optional `skills.meta.appearance` field in skill catalogs and IaC manifests, with validation for its string record shape.

## 0.9.1

### Patch Changes

- d987bcd: Display assigned scopes directly in CLI access output instead of replacing them with potentially misleading permission descriptions.

## 0.9.0

### Minor Changes

- 16b8064: Add complete Ubuntu, macOS, and Windows CLI support plus self-contained standalone release assets. Initial standalone assets are unsigned and should be verified with the published SHA-256 checksums.

## 0.8.0

### Minor Changes

- 43587f9: Add native Weldall YAML infrastructure-as-code commands for scopes, resources, machine clients, administrator-managed skills, and assignments, with committed lockfile state, atomic planning/apply workflows, and Linux packaging with optional macOS Keychain support.

## 0.7.0

### Minor Changes

- 6aaeaa2: Add native Weldall YAML infrastructure-as-code commands, committed lockfile state, atomic planning/apply workflows, and Linux packaging with optional macOS Keychain support.

## 0.6.0

### Minor Changes

- 4c89941: Render human-facing CLI output with Ink using bordered, color-coded account, access, skill, configuration, notice, and help panels. Root help stacks the Weldall account, organization instructions, and capped scope and skill previews while preserving plain machine-readable output.

## 0.5.0

### Minor Changes

- 27eddb1: Add authenticated resource skill publication, persisted Weldall discovery, source metadata, partial catalog warnings, and extensible skill visibility values.

### Patch Changes

- e33b4e0: Show only API names in the status output's available APIs section.

## 0.4.1

### Patch Changes

- 62f4673: Require explicit approval for every native CLI login, make cross-process credential locking race-safe, and preserve rotated refresh credentials before follow-up validation.

  Harden SDK error responses, authorization-server metadata, replay classification, request-target matching, and published security guidance.

## 0.4.0

### Minor Changes

- 97a3552: Carry Weldall-verified email claims through ID-JAG exchange into downstream access tokens and expose them in the SDK authentication context.
- 0edef3d: Add streaming raw and multipart file uploads plus binary-safe, atomic response downloads to `weldall request`.

## 0.3.0

### Minor Changes

- 27ac58e: Render compact framed CLI context, cache administrator instructions, and distinguish all assigned scopes from permissions exposed by enabled APIs.

## 0.2.1

### Patch Changes

- aa7d279: Replace the animated CLI header with a centered Weldall wordmark and agent-focused introduction.

## 0.2.0

### Minor Changes

- f4c413e: Publish the macOS CLI through npm as @weldall/cli.
