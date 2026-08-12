# @weldall/cli

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
