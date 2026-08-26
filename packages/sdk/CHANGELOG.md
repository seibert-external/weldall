# @weldall/sdk

## 0.6.0

### Minor Changes

- 2ae041c: Support the optional `skills.meta.appearance` field in skill catalogs and IaC manifests, with validation for its string record shape.

## 0.5.0

### Minor Changes

- ac4d043: Allow resource servers to retrieve Weldall authorization-server metadata and signing keys through a dedicated discovery proxy while retaining canonical issuer validation.

## 0.4.0

### Minor Changes

- 2b79697: Add private-key machine client credentials with independent resource/scope access selection and DPoP-bound target verification.

## 0.3.0

### Minor Changes

- 27eddb1: Add authenticated resource skill publication, persisted Weldall discovery, source metadata, partial catalog warnings, and extensible skill visibility values.

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
