# Native Weldall YAML infrastructure as code

Weldall IaC v1 uses native YAML and the existing `weldall` CLI. Terraform, OpenTofu, HCL, Terraform state, and provider compatibility are unsupported and outside v1.

## Bootstrap automation

An administrator creates a machine client, registers its public ES256 P-256 JWK, and allows the protected machine-only `weldall:iac` scope. CI stores the matching M2M environment variables:

```sh
export WELDALL_M2M_CLIENT_ID=platform-ci
export WELDALL_M2M_KID=ci-2026
export WELDALL_M2M_PRIVATE_JWK='{"kty":"EC","crv":"P-256","x":"…","y":"…","d":"secret"}'
export WELDALL_M2M_PUBLIC_JWK='{"kty":"EC","crv":"P-256","x":"…","y":"…"}'
```

Private material belongs only in the CI secret store. It must never be placed in `weldall.yml`, fragments, `weldall.lock.yml`, logs, plans, errors, or audit records.

## Workflow

```sh
weldall init --name platform-access --issuer https://weldall.example.com
weldall validate
weldall plan
weldall plan --json
weldall up --yes
```

Commit `weldall.yml`, fragments, and `weldall.lock.yml`. A complete desired snapshot is planned deterministically and committed in one serializable database transaction. Non-interactive apply fails without `--yes`. Manual objects omitted from YAML remain untouched.

If a YAML natural identity already exists manually, `plan` reports a collision. Claim it explicitly:

```sh
weldall import scope expenses:read --as scope.expenses_read
```

An import never steals another workspace's object or imports a protected system scope. Remove a declaration before preserving the live object and releasing ownership:

```sh
weldall unmanage scope.expenses_read --yes
```

Changing a logical address requires an explicit move:

```sh
weldall state mv scope.old scope.new
```

## Drift, deletion, and recovery

Admin UI edits to owned objects remain possible and appear as drift on the next plan; `up` restores YAML. Manual deletion leaves an ownership tombstone and the next apply recreates the object. Removing an owned declaration deletes it, while removing a public key irreversibly revokes it. `enabled: false` deactivates a machine; removing the machine hard-deletes it.

If the server commits but atomic local lockfile replacement fails, retry the idempotent command or run:

```sh
weldall state pull
```

The server binding is authoritative. The lockfile is only a committed cache and review artifact.

## Safe key rotation

1. Add a new public key ID to YAML and apply with the old key.
2. Change CI to the new private key.
3. Remove the old public key and apply while authenticated with the new key.

The active runner cannot disable or delete itself, remove its own `weldall:iac` access, or revoke the authenticating key in the same apply. Revoked key IDs cannot be reactivated.

See [`schemas/weldall-manifest-v1alpha1.schema.json`](../schemas/weldall-manifest-v1alpha1.schema.json), [`schemas/weldall-iac-v1.openapi.yml`](../schemas/weldall-iac-v1.openapi.yml), and the complete [implementation contract](../tasks/weldall-iac.md).
