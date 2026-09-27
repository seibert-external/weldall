---
title: Connectors
description: Call Google APIs on behalf of the signed-in user.
---

Connectors let you call a service **on behalf of the user**. Each person connects their own account and approves access. Weldall keeps the credentials encrypted on the server and makes the calls; provider tokens never reach the CLI.

Google is currently the only supported connector OAuth client. Want to use another service with an API token? You can already do that through a [resource](../service-configuration/) that proxies requests to it and keeps the token server-side. Connectors are for personal, user-authorized access—not a requirement for every integration.

## Set up Google

In **Admin → Connectors**, add a Google connector with your Google OAuth client ID and secret. Register `https://weldall.example.com/api/connectors/google/callback` as an authorized redirect URI in Google, replacing the origin with your Weldall URL. Choose the Google permissions to offer and the Weldall scopes users need to access the connector, then enable it.

Users can then connect their own account. For a connector with the key `google`:

```sh
weldall connectors
weldall connections connect google --name my-google
weldall request --connection my-google \
  https://www.googleapis.com/calendar/v3/calendars/primary/events
```

Approve Calendar access during setup to use this example. Use `--connection` instead of `--scope` for connector requests. The connection belongs to you and works across your signed-in devices.

To remove it, run `weldall connections disconnect my-google`. Weldall attempts to revoke access at Google and removes the stored connection. If revocation cannot be confirmed, the CLI asks you to finish in your Google account settings.

## Two keys, one small envelope

Weldall uses **envelope encryption**. Think of every stored credential as a locked parcel:

1. On every write, Weldall creates a fresh 32-byte **DEK** (data-encryption key) and uses it to encrypt the credential locally.
2. A **KEK** (key-encryption key) wraps that DEK. PostgreSQL receives only the encrypted credential and wrapped DEK.
3. On read, the selected provider unwraps the DEK and Weldall decrypts the credential locally.

Why two keys? A fresh DEK limits how much one data key can unlock, while the KEK stays outside PostgreSQL. A database backup alone is therefore not enough to reveal credentials. OpenBao can also rotate its KEKs without rewriting stored credentials.

### Pick the KEK holder once

The envelope provider is permanent after connector creation: neither the UI, API, nor IaC can switch `LOCAL_ENV` to `OPENBAO` or back again. To switch, create a new connector and reconnect users.

- **`LOCAL_ENV` (default)** keeps one shared KEK in `WELDALL_CONNECTOR_KEK`, an independent, base64-encoded 32-byte key. Keep it stable in your secret manager and separate from database backups. Anyone with both the database and this KEK can decrypt all `LOCAL_ENV` connector credentials.
- **`OPENBAO`** keeps one `aes256-gcm96` Transit KEK per connector. OpenBao creates it on first use; every protected write uses one encrypt request and every read uses one decrypt request. Rotate it in OpenBao whenever you like—old ciphertext keeps working. Weldall never rotates or deletes Transit keys.

`WELDALL_CREDENTIAL_ENCRYPTION_KEY` is separate: it still protects OAuth client secrets. OpenBao protects user connection credentials only.

### Set up OpenBao

Point Weldall at your server and hand it a data-plane token:

```dotenv
WELDALL_OPENBAO_HOST=https://openbao.example.com
WELDALL_OPENBAO_TOKEN=...
```

Enable the Transit secrets engine first, then grant only the required paths:

```hcl
path "transit/encrypt/weldall-connector-*" { capabilities = ["create", "update"] }
path "transit/decrypt/weldall-connector-*" { capabilities = ["update"] }
```

OpenBao is contacted only when credentials need encrypting or decrypting. Missing variables, downtime, or a rejected token fail just that operation with a sanitized `503`; startup, connector administration, and `LOCAL_ENV` connectors keep working. Back up OpenBao independently from PostgreSQL, and remove leftover `weldall-connector-*` keys yourself after deleting a connector.

KMS support is still coming soon.
