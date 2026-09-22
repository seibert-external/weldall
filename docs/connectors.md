# Google connectors

Connector V1 lets administrators configure one or more Google OAuth clients and lets each user connect personal Gmail and Google Calendar accounts. Google API data is not copied into Weldall. Access and refresh tokens are handed off once to the authenticated owner with the matching submitted device identifier and stored only in the CLI's operating-system credential store.

## Domain model

- **Connector:** reusable configured provider integration, including OAuth client configuration and fixed target rules.
- **PersonalConnection:** one user's provider account on one device, with local credentials and direct CLI requests. `PersonalConnectionAuthorization` is its temporary OAuth handoff, not a durable credential store.
- **SharedConnection (future):** a separate primitive referencing a connector, with server-held credentials, explicit access grants, and backend-executed requests. It is not another mode of PersonalConnection and is not implemented in V1.

The personal model has required owner/device fields and no `credentialMode`. The CLI retains `connections` and `request --connection`; those commands and `/api/me/connections` exclusively address personal connections. Provider OAuth operations and token types can be reused later, but storage, permissions, and lifecycle remain separate.

Disconnect deletes the personal connection server-side before best-effort Google revocation; it does not rely on an abandoned CLI deleting local secrets. Already-issued Google tokens can still be used outside Weldall until Google expires or revokes them.

## Administrator setup

1. In Google Cloud, enable the Gmail API and/or Google Calendar API.
2. Configure the OAuth consent screen and request only the scopes needed by the installation. Gmail scopes can require Google verification.
3. Create a Web application OAuth client with the callback URL for the installation's `WELDALL_ISSUER`. Public docs and examples use:

   ```text
   https://weldall.example.com/api/connectors/google/callback
   ```

4. Open **Administration → Connectors**, create a Google connector, select its enabled APIs and scopes, and enter the OAuth client ID and secret. **Test configuration** validates the selected values and Google's published OAuth endpoints; the first user authorization verifies that the client ID, secret, and redirect URI belong together.

The client secret is encrypted with `WELDALL_CREDENTIAL_ENCRYPTION_KEY` and is write-only after creation. Disabling a connector blocks new authorization flows and leases for every associated connection. A connector with existing personal connections cannot be deleted.

- **Gmail target:** `https://gmail.googleapis.com/gmail/v1/`
- **Calendar target:** `https://www.googleapis.com/calendar/v3/`

## User commands

```sh
weldall connectors list
weldall connectors show google
weldall connections connect google --name my-google
weldall connections list
weldall request --connection my-google \
  https://www.googleapis.com/calendar/v3/users/me/calendarList
weldall connections reconnect my-google
weldall connections rename my-google google-work
weldall connections disconnect google-work
```

Connection names are convenient for interactive use; stable connection IDs are preferred in scripts. `--connection` and `--scope` are mutually exclusive.

Before a provider request, the CLI obtains a signed one-minute lease from Weldall. Weldall verifies ownership, connector and connection status, the HTTP method, and the fixed API target. The CLI independently verifies the lease and target before reading the local credential. Redirects and caller-supplied transport credentials are rejected.

## V1 limits

- Google only; Gmail and Google Calendar only.
- Personal, device-local credentials only.
- No SharedConnection, sharing, service accounts, background jobs, server-managed provider credentials, or external connector services.
- A local token extracted outside the official CLI remains usable until Google expires or revokes it.
