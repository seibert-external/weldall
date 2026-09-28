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

## Request limits

Weldall allows **60 requests per connection in each 60-second window**. Once that limit is reached, it returns HTTP `429` before contacting OpenBao or Google. Requests that pass this check still count if they later fail. This is Weldall's limit; Google's API limits apply separately.

You can also have up to **10 open, unexpired connection-setup attempts per user**, across all connectors. Each attempt is valid for ten minutes. Cancel unused attempts or wait for them to expire before starting another.

## Credential encryption

Weldall generates a new 32-byte key each time it stores credentials and uses it to encrypt them. It then encrypts this data-encryption key (DEK) with a second key, the key-encryption key (KEK). This is called **envelope encryption**.

PostgreSQL stores only the encrypted credentials and the encrypted DEK. To read the credentials, the DEK is decrypted first, then Weldall uses it to decrypt the credentials. The KEK stays outside the database, so a stolen database backup alone is not enough to read them.

### Manage encryption keys

When you create a connector, you choose where its KEK is managed. You cannot change that choice later, including through the API or IaC. To switch providers, create a new connector and ask users to reconnect their accounts.

- **`LOCAL_ENV` (default):** Set `WELDALL_CONNECTOR_KEK` on the Weldall server to a base64-encoded key made from 32 random bytes, generated independently of your other keys. All `LOCAL_ENV` connectors use this KEK. Keep it unchanged in your secret manager, separate from database backups. Anyone with both the database and the KEK can decrypt these connectors' credentials.
- **`OPENBAO`:** OpenBao manages a separate `aes256-gcm96` Transit key for each connector and creates it on the first encryption request. Weldall calls OpenBao once per write to encrypt the DEK and once per read to decrypt it. You can rotate the Transit key in OpenBao without rewriting stored credentials; they remain readable.

Weldall still encrypts OAuth client secrets with `WELDALL_CREDENTIAL_ENCRYPTION_KEY`, regardless of the envelope provider you choose.

### Set up OpenBao

Set your OpenBao server's address and an access token on the Weldall server:

```dotenv
WELDALL_OPENBAO_HOST=https://openbao.example.com
WELDALL_OPENBAO_TOKEN=...
```

Enable the Transit secrets engine at `transit/` in OpenBao. The token only needs these permissions:

```hcl
path "transit/encrypt/weldall-connector-*" { capabilities = ["create", "update"] }
path "transit/decrypt/weldall-connector-*" { capabilities = ["update"] }
```

Weldall only needs OpenBao when encrypting or decrypting connection data. If a variable is missing, OpenBao is unreachable, or the token is rejected, that operation fails with HTTP `503`. The error message contains no secrets. Weldall still starts, you can still manage connectors, and `LOCAL_ENV` connectors keep working.

Back up OpenBao as well as PostgreSQL. Weldall does not rotate or delete Transit keys automatically. After deleting a connector, remove its `weldall-connector-*` key in OpenBao yourself once you no longer need it.
