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

## Keep the key safe

If you use connectors, set **`WELDALL_CONNECTOR_KEK`** on the Weldall server: an independent, base64-encoded 32-byte random key. Keep it stable and store it in your secret manager, separately from database backups. It is separate from `WELDALL_CREDENTIAL_ENCRYPTION_KEY`, which protects OAuth client secrets.

Today, connectors use `LOCAL_ENV`: this key wraps the keys that encrypt stored connection credentials. **If an attacker gets both the database and the KEK, those credentials are exposed.** Database encryption alone is not protection against that combination.

OpenBao, KMS, and key rotation are not currently supported.
