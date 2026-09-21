# Google connectors

Connector V1 lets administrators configure one or more Google OAuth clients and lets each user connect personal Gmail and Google Calendar accounts. Google API data is not copied into Weldall. Access and refresh tokens are returned once to the initiating CLI and stored only in its operating-system credential store.

## Administrator setup

1. In Google Cloud, enable the Gmail API and/or Google Calendar API.
2. Configure the OAuth consent screen and request only the scopes needed by the installation. Gmail scopes can require Google verification.
3. Create a Web application OAuth client with the callback URL for the installation's `WELDALL_ISSUER`. Public docs and examples use:

   ```text
   https://weldall.example.com/api/connectors/google/callback
   ```

4. Open **Administration → Connectors**, create a Google connector, select its enabled APIs and scopes, and enter the OAuth client ID and secret. **Test configuration** validates the selected values and Google's published OAuth endpoints; the first user authorization verifies that the client ID, secret, and redirect URI belong together.

The client secret is encrypted with `WELDALL_CREDENTIAL_ENCRYPTION_KEY` and is write-only after creation. Disabling a connector blocks new authorization flows and leases for every associated connection. A connector with connection history cannot be deleted.

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
- No sharing, service accounts, background jobs, managed credentials, or external connector services.
- A local token extracted outside the official CLI remains usable until Google expires or revokes it.
