# @weldall/sdk

## 0.2.1

### Patch Changes

- 62f4673: Require explicit approval for every native CLI login, make cross-process credential locking race-safe, and preserve rotated refresh credentials before follow-up validation.

  Harden SDK error responses, authorization-server metadata, replay classification, request-target matching, and published security guidance.

## 0.2.0

### Minor Changes

- 97a3552: Carry Weldall-verified email claims through ID-JAG exchange into downstream access tokens and expose them in the SDK authentication context.

## 0.1.0

### Minor Changes

- 3971089: Publish the framework-neutral Weldall resource-server SDK with Hono, Next.js, and Astro adapters.
