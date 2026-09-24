---
title: Managed Google connections
description: Owner-only Gmail and Calendar connections with server-side credential custody.
---

Weldall executes supported Gmail and Google Calendar requests on behalf of the connection's owner. Provider access and refresh tokens are encrypted in PostgreSQL and never sent to the CLI. Your normal Weldall login credentials and DPoP keys stay in the operating system's secure store, unchanged.

## Administrator setup

1. Provision **two independent** cryptographically random 32-byte keys (canonical base64) in the server environment: `WELDALL_CREDENTIAL_ENCRYPTION_KEY` and `WELDALL_CONNECTOR_KEK`. Generate each with `openssl rand -base64 32`. Keep existing application key material unchanged. Provision identical material on every serving instance; never put it in manifests, logs or CI arguments.
2. In **Administration → Connectors**, create a disabled Google connector with a stable key such as `google`, its OAuth client ID, enabled APIs, allowed permissions and explicit default permissions. Select **Local environment key** (`LOCAL_ENV`) as the envelope provider. This choice is immutable; detail/edit views show it read-only. **OpenBao — Upcoming** is disabled and not yet supported by UI, server APIs or IaC.
3. Provision the OAuth client secret using the separate write-only control, then enable the connector. Configure a Google **Web application** OAuth client with the exact redirect URI `https://weldall.example.com/api/connectors/google/callback` for your installation.
4. Enable the Gmail and Calendar APIs in the Google project. Before production rollout, verify Google's OAuth verification, restricted Gmail scope/security-assessment requirements, Limited Use policy and your server-side data-handling obligations. This implementation is not Google approval.

The envelope-provider boundary wraps and unwraps DEKs without exposing its KEK to callers. No external KMS integration is included.

Configuration is editable through both the UI and [IaC](./infrastructure-as-code/). PostgreSQL is the runtime authority. UI changes to IaC-managed objects take effect immediately; the next approved apply restores manifest values. The OAuth client secret is never a manifest field and is preserved by non-secret applies unless the OAuth client ID changes. To replace the OAuth client, first remove connections and attempts, save the connector disabled with the new client ID, provision the new write-only secret, then enable it.

## Connect and use

```sh
weldall connectors
weldall connections connect google --name my-google
weldall connections list
weldall connections show my-google
weldall request --connection my-google \
  https://weldall.example.com/connectors/google/calendar/v3/calendars/primary/events
weldall request --connection my-google \
  'https://weldall.example.com/connectors/google/gmail/v1/users/me/messages?maxResults=20'
weldall connections reconnect my-google
weldall connections disconnect my-google
weldall connections delete my-google
```

Connection and connector lists render as terminal tables. Add `--json` for stable machine-readable output or `--agentic` for compact TOON; `connections show` and `connections status` support the same flags.

The browser must be signed into the **same Weldall user** that started setup. If necessary, sign in in another tab, then reload the setup page. The ten-minute link alone is not authorization. Required identity permissions cannot be removed. Optional API permissions can be unticked, including every permission for one of the enabled services, provided another usable capability remains. The Google consent screen follows Weldall's selection form.

Selected permissions, provider grants and current administrator policy are separate boundaries. Broad scopes may include capabilities from unticked narrower scopes; the form explains these implications. Google may grant fewer optional permissions; `connections show` reports effective capabilities. Missing identity permissions or all API capabilities prevent activation. Reconnect retains the connection ID and Google account, and preserves the old connection if the replacement fails. Unchecking a box does not revoke Google's underlying grant.

Setup prints an attempt ID. After interruption, use `weldall connections status <attempt-id>`; an already completed connection remains available on every device signed into the same Weldall account. `weldall connections cancel <attempt-id>` cancels an unfinished attempt or retries revocation of an unused grant retained after a rejected callback. List views return at most 200 recent entries; a connection can always be selected directly by its name or ID.

## Request contract and limits

Built-in connectors belong to the existing **Weldall API resource** (`<issuer>/api`), not a separate downstream token exchange. Discovery is `GET /api/me/connectors`. Requests use Weldall's DPoP-bound API access token with `weldall:scopes`, a live `weldall:login` grant, and the `X-Weldall-Connection` selector. Every request checks ownership, connector/connection state, and the intersection of selected, granted and administrator-allowed provider capabilities. Administrative privileges do **not** allow use of another owner's connection. Shared PostgreSQL replay markers reject reused DPoP proofs across instances.

`--connection` replaces `--scope` for these built-ins. Ordinary `--scope` resource requests, their token exchange, uploads/downloads and offset pagination are unchanged.

Supported operations are deliberately explicit (see `server/connectors/registry.ts`):

- Gmail: read messages, threads, labels, profile and attachments; send messages; modify/trash/untrash messages and threads. Only `users/me` is accepted. Permanent deletion, batch endpoints, drafts, settings and arbitrary Google APIs are not exposed.
- Calendar: read calendar lists/calendars; read events and instances; create, update and delete events. Calendar ACLs, watches and other operations are not exposed.
- Fixed upstream origins; no redirects, caller-supplied provider authentication, Weldall credentials, cookies, arbitrary query parameters or ambiguous paths are forwarded.
- 10 MiB maximum request and response, bounded buffering/stream reads, 30-second transfer timeout, 10-second token/revocation calls, and 60 dispatches per connection per minute. No automatic retry after dispatch, including side-effecting operations.
- JSON and raw Gmail RFC 822 `uploadType=media` uploads are supported within these limits. Gmail attachment downloads remain Google's base64url JSON representation. CLI `--json`, `--data`, `--upload-file` and `--output` retain their normal transfer behavior; generic multipart/form-data is not a Google mail-upload format.
- Google uses `nextPageToken`/`pageToken`: pass the returned token in a subsequent URL on the **same Weldall origin**. `--paginate offset` is only for normal resources, not Google.

## Lifecycle and recovery

Refresh uses a persisted status/version claim, not an in-process lock. Competing requests receive a conflict and can retry after refresh. Explicit transient provider errors retain readiness; authorization loss, malformed/ambiguous responses or an interrupted refresh require reconnect. Changed grants never expand the selected boundary. A refresh that would add effective capabilities beyond the previous grant requires interactive reconnect rather than silently enabling them. There is no atomic transaction spanning Google and PostgreSQL: a crash after Google rotates a refresh token but before persistence may require reconnect or manual revocation in Google account settings.

Disconnect first commits **REVOCATION_PENDING**, blocking new requests, then makes one bounded provider call outside the transaction. Confirmed revocation removes encrypted credentials. Failure or interruption retains encrypted retry material but never permits normal use; explicitly repeat disconnect. Even `invalid_token` is not treated as proof that the account/client grant was revoked: an interrupted refresh may have rotated that token. If refresh is in flight, retry disconnect after it finishes so any rotated token can be revoked. Google revocation can affect **other authorizations for the same account/client**. Already-dispatched requests cannot be retroactively cancelled.

Administrators inspect permissions, request dispatch counts, last use, health and revocation state under **Managed connections**. Audit records include actor, connection/account, sanitized operation, outcome and duration, not tokens, request bodies or sensitive query values. Owner deletion and connector removal are blocked while dependent connections/attempts remain. Delete a connection only after confirmed disconnect or explicitly acknowledged administrator terminal cleanup. Completed/expired non-sensitive attempts are cleaned in bounded batches when setup or connector removal runs.

A failed callback that obtained tokens retains them on its authorization attempt for explicit revocation. An interrupted code exchange may have created a grant even if no tokens reached storage. Administrators can inspect/retry retained grants and perform explicitly acknowledged **terminal cleanup** of expired attempts or revocation-pending connections. This discards retry material, records revocation as unconfirmed and does not revoke a lost Google grant; revoke that grant in Google account settings first. A terminally cleaned connection is locally `DISCONNECTED` but retains the unconfirmed outcome in `revocationError`; CLI disconnect still reports non-success. Interactive reconnect can preserve a disconnected connection's ID and account binding.

## Encryption and restoration

There are exactly two encryption modes:

- **Fixed application encryption:** `WELDALL_CREDENTIAL_ENCRYPTION_KEY` directly encrypts login/OIDC client secrets, login authorization-attempt payloads, group-provider passwords/tokens, and configured connector OAuth client secrets with AES-256-GCM. These values do not use envelope encryption.
- **Connector envelope encryption:** each write generates a fresh random 32-byte data encryption key (DEK) and encrypts the complete credential object (access token, refresh token, expiry and granted scopes) with AES-256-GCM. Token refresh replaces the whole object with a new DEK. Sensitive connector authorization-attempt payloads use the same envelope path. `WELDALL_CONNECTOR_KEK` wraps each DEK with AES-256-GCM using its own fresh nonce; it never directly encrypts provider credentials. All `LOCAL_ENV` connectors share this deployment KEK, but no records or writes share DEKs. Only ciphertext, wrapped DEKs and authenticated metadata are persisted, never plaintext DEKs.

Both encryption layers bind stable entity IDs and purposes, not mutable display names. Missing, malformed or replaced key material fails closed. Production readiness checks validate stored connector secrets and envelopes before serving traffic. There is **no rotation support** for fixed application encryption or the initial local envelope provider, and an existing connector cannot switch providers. Do not replace either environment key to attempt rotation.

Restore the database **and its corresponding, separately protected deployment secrets** together. Loss or replacement of either environment key makes the corresponding secrets unavailable; a database-only backup cannot restore usable connections. Never generate fallback keys. This protects against database-only disclosure, not compromise of the application process or environment.

External connector discovery, connection IaC management and connection sharing are not implemented. There are no provider credentials in CLI storage, compatibility endpoints, leases or background maintenance services.
