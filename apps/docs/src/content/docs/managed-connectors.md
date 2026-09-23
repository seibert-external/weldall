---
title: Managed Google connections
description: Owner-only Gmail and Calendar connections with server-side credential custody.
---

Weldall executes supported Gmail and Google Calendar requests on behalf of the connection's owner. Provider access and refresh tokens are encrypted in PostgreSQL and never sent to the CLI. Your normal Weldall login credentials and DPoP keys stay in the operating system's secure store, unchanged.

## Administrator setup

1. Provision a cryptographically random 32-byte key (canonical base64) in the Weldall server's environment, for example with `openssl rand -base64 32`. Choose the variable name yourself. Put **only approved variable names**, comma-separated, in `WELDALL_ENCRYPTION_SOURCES`. Provision identical material on every serving instance; never put material in manifests, logs or CI arguments.
2. In **Administration → Connectors & keys**, create an encryption key, register version `1` with that environment source, and select it as active. The configuration and immutable material fingerprint live in PostgreSQL; the actual key does not.
3. Create a disabled Google connector with a stable key such as `google`, its OAuth client ID, enabled APIs, allowed permissions, explicit default permissions and encryption-key selection. Provision its client secret using the separate write-only control, then enable it. Configure a Google **Web application** OAuth client with the exact redirect URI `https://weldall.example.com/api/connectors/google/callback` for your installation.
4. Enable the Gmail and Calendar APIs in the Google project. Before production rollout, verify Google's OAuth verification, restricted Gmail scope/security-assessment requirements, Limited Use policy and your server-side data-handling obligations. This implementation is not Google approval.

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

## Encryption-key rotation and restoration

Key configuration revision, cryptographic key version and envelope format version are different. Each envelope records its exact historical key/version and uses AES-256-GCM with a fresh nonce and authenticated purpose/entity binding. Missing, malformed, unapproved or replaced key material fails closed.

1. Provision a new environment secret on all serving instances, retaining old material.
2. Register its **new immutable version** and activate it in the UI or IaC. New writes use it; existing values still use their recorded key/version.
3. Optionally run **Re-encrypt existing values** on each connector. This is an explicit synchronous serializable transaction, including client secret, connection credentials and sensitive attempts. Any failure/conflict rolls back all changes. It is limited to 1,000 encrypted values per connector; larger sets require an explicit maintenance procedure, not a background queue.
4. Key reassignment works the same way. A referenced logical key cannot be deleted. Historical version mappings cannot be removed or rebound; retain their secrets for the supported backup/recovery window. Rotation does not revoke potentially exposed Google tokens.

Restore the database **and separately protected historical environment material and allowlist** together. In an isolated maintenance deployment, verify key availability, decrypt an existing connection using its recorded version, and verify an explicit re-encryption transaction before serving traffic. A database-only backup cannot restore usable connections. Never generate replacement material under an old version identity. Application encryption protects a database-only leak, not an attacker controlling the server process and its environment.

External connector discovery, connection IaC management and connection sharing are not implemented. There are no provider credentials in CLI storage, compatibility endpoints, leases or background maintenance services.
