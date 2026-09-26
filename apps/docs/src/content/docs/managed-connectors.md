---
title: Managed Google connections
description: Owner-only Gmail and Calendar connections with server-side credential custody.
---

Weldall proxies arbitrary Google API paths on reviewed origins on behalf of the connection's owner. Google enforces authorization using the exact scopes selected during setup. Provider access and refresh tokens are encrypted in PostgreSQL and never sent to the CLI. Your normal Weldall login credentials and DPoP keys stay in the operating system's secure store, unchanged.

## Administrator setup

1. Provision **two independent** cryptographically random 32-byte keys (canonical base64) in the server environment: `WELDALL_CREDENTIAL_ENCRYPTION_KEY` and `WELDALL_CONNECTOR_KEK`. Generate each with `openssl rand -base64 32`. Keep existing application key material unchanged. Provision identical material on every serving instance; never put it in manifests, logs or CI arguments.
2. In **Administration → Connectors**, create a Google connector with a stable key such as `google`, its OAuth client ID and client secret, allowed permissions and explicit default permissions. Select **Local environment key** (`LOCAL_ENV`) as the envelope provider. This choice is immutable; detail/edit views show it read-only. **OpenBao — Upcoming** is disabled and not yet supported by UI, server APIs or IaC.
3. Enable the connector and save once: configuration and client secret are saved together. When editing, leave the secret empty to keep it, or enter a replacement; secrets are never displayed again. Configure a Google **Web application** OAuth client with the exact redirect URI `https://weldall.example.com/api/connectors/google/callback` for your installation.
4. Enable the Gmail and Calendar APIs in the Google project. Before production rollout, verify Google's OAuth verification, restricted Gmail scope/security-assessment requirements, Limited Use policy and your server-side data-handling obligations. This implementation is not Google approval.

The envelope-provider boundary wraps and unwraps DEKs without exposing its KEK to callers. No external KMS integration is included.

Configuration is editable through both the UI and [IaC](./infrastructure-as-code/). PostgreSQL is the runtime authority. UI changes to IaC-managed objects take effect immediately; the next approved apply restores manifest values. Optional required Weldall scopes control access independently of Google's provider permissions: an empty set allows every login-authorized user, while a non-empty set requires every listed scope to create, reconnect, complete setup, inspect, or use a connection. Losing access does not prevent cancellation or disconnect cleanup. Scope assignments are managed separately.

The OAuth client secret is never a manifest field and is preserved by non-secret applies unless the OAuth client ID changes. To replace the OAuth client, first remove connections and attempts. In the UI, save the new client ID and secret together. With IaC, apply the new client ID while disabled, enter the new secret in the UI, then enable through IaC.

## Connect and use

```sh
weldall connectors
weldall connections connect google --name my-google
weldall connections list
weldall connections show my-google
weldall request --connection my-google \
  https://www.googleapis.com/calendar/v3/calendars/primary/events
weldall request --connection my-google \
  'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20'
weldall connections reconnect my-google
weldall connections disconnect my-google
```

Connection and connector lists render as terminal tables. Add `--json` for stable machine-readable output or `--agentic` for compact TOON; `connections show` and `connections status` support the same flags.

The browser must be signed into the **same Weldall user** that started setup. If necessary, sign in in another tab, then reload the setup page. The Google callback checks this authenticated owner before consuming state or exchanging the code; another valid session for the same Weldall user is allowed. Neither the ten-minute setup link nor a forwarded Google authorization URL is sufficient authorization. Required identity permissions cannot be removed. Optional API permissions can be unticked, provided at least one API scope remains. The Google consent screen follows Weldall's selection form.

The administrator offers a maximum scope set; the owner selects a subset plus required protocol scopes (`openid` and `https://www.googleapis.com/auth/userinfo.email`). Weldall requests Google's full email scope URI directly rather than translating aliases in grants. The provider must grant exactly that requested set. Sets are deduplicated and sorted, with no alias or implication mappings: reduced, expanded, and renamed scopes all fail activation and refresh. Broad scopes allow every operation Google authorizes with them, including operations covered by unticked narrower scopes. `connections show` reports selected and granted scopes. Reconnect retains the connection ID and Google account, and preserves the old connection if the replacement fails. Unchecking a box does not revoke Google's underlying grant.

Setup prints an attempt ID. After interruption, use `weldall connections status <attempt-id>`; an already completed connection remains available on every device signed into the same Weldall account. `weldall connections cancel <attempt-id>` cancels an unfinished attempt or retries revocation of an unused grant retained after a rejected callback. List views return at most 200 recent entries; a connection can always be selected directly by its name or ID.

## Request contract and limits

Built-in connectors belong to the existing **Weldall API resource** (`<issuer>/api`), not a separate downstream token exchange. Discovery is `GET /api/me/connectors` and omits connectors whose required Weldall scopes the caller does not hold. Requests use Weldall's DPoP-bound API access token with `weldall:scopes`, a live `weldall:login` grant, and the `X-Weldall-Connection` selector. Every request checks ownership, connector/connection state, all required Weldall scopes, current administrator policy, and exact requested/granted Google scopes. Core calls the adapter's `ensureGrantCurrent` before every dispatch; Google reconciles the stored grant locally. Administrative privileges do **not** allow use of another owner's connection. Shared PostgreSQL replay markers reject reused DPoP proofs across instances.

`--connection` replaces `--scope` for these built-ins. Ordinary `--scope` resource requests, their token exchange, uploads/downloads and offset pagination are unchanged.

The CLI accepts full URLs from provider documentation. It sends requests only to Weldall's `/connectors/<key>` endpoint, carrying the original URL in `X-Weldall-Upstream-URL`. This is untrusted metadata, never an authorization claim. Only the provider adapter can create a branded trusted upstream URL.

- Reviewed Google origins: `https://gmail.googleapis.com`, `https://www.googleapis.com`, and `https://calendar.googleapis.com`. No administrator-configured origins, wildcards, tenant overrides or redirects.
- Arbitrary API paths, versions and query parameters are accepted on these origins. There are no endpoint regexes, operation catalogs, or endpoint-to-scope mappings. Google decides whether a request is authorized.
- URLs must be HTTPS, at most 8 KiB, with no credentials, fragments, unexpected ports, malformed encoding, backslashes, dot segments, encoded path separators or nested path escapes. Explicit port 443 is canonicalized away.
- A 32 KiB header bound and core denylist remove authorization, cookies, host/framing/hop-by-hop, proxy/forwarded, DPoP and internal Weldall headers, including Connection-nominated headers. Google additionally removes `X-Goog-*` and method-override headers before adding its bearer credential. Ordinary end-to-end headers pass through. Responses remove cookies, hop-by-hop, length and content-encoding headers; framing is regenerated after bounded buffering.
- 10 MiB maximum request and response, bounded buffering/stream reads, 30-second transfer timeout, 10-second token/revocation calls, and 60 dispatches per connection per minute. No automatic retry after dispatch, including side-effecting operations.
- JSON and raw Gmail RFC 822 `uploadType=media` uploads are supported within these limits. Gmail attachment downloads remain Google's base64url JSON representation. CLI `--json`, `--data`, `--upload-file` and `--output` retain their normal transfer behavior; generic multipart/form-data is not a Google mail-upload format.
- Google uses `nextPageToken`/`pageToken`: pass the returned token in a subsequent **provider URL**, still using `--connection`. `--paginate offset` is only for normal resources, not Google.

## Lifecycle and recovery

Refresh uses a persisted status/version claim, not an in-process lock. Competing requests receive a conflict and can retry after refresh. Explicit transient provider errors retain readiness; authorization loss, malformed/ambiguous responses or an interrupted refresh require reconnect. Any reduced or expanded grant requires interactive reconnect. Rejected rotated credentials remain encrypted solely for explicit revocation, never execution. There is no atomic transaction spanning Google and PostgreSQL: a crash after Google rotates a refresh token but before persistence may require reconnect or manual revocation in Google account settings.

The owner/CLI disconnect first commits **REVOCATION_PENDING**, blocking new requests and callbacks, then makes bounded provider calls outside the transaction. It permanently deletes the connection, linked attempts and encrypted credentials whether revocation is confirmed or not, so the same name can be registered again immediately. Unconfirmed revocation produces a warning and an audit record; remove access in Google account settings because Weldall can no longer retry. If refresh or token exchange is in flight, retry disconnect after it finishes so any rotated token can be included in the best-effort revocation. Google revocation can affect **other authorizations for the same account/client**. Already-dispatched requests cannot be retroactively cancelled.

Administrators inspect permissions, request dispatch counts, last use, health and revocation state under **Managed connections**. Request audits include actor, connection, provider, method, status, duration and a keyed HMAC-SHA256 fingerprint of the canonical requested URL and method. No raw or “sanitized” provider paths, query values, grants, credentials, or response bodies are logged. The audit key is domain-separated from `WELDALL_CREDENTIAL_ENCRYPTION_KEY`; stable deployment key material permits correlation without offline path guessing. Completed/expired non-sensitive attempts are cleaned in bounded batches when setup runs. Administrative deletion is independent of provider availability and does not require usable encryption keys.

Authorization attempts are internal OAuth state, not an administrative table or deletion API. A failed callback that obtained tokens retains them for owner-initiated cancellation and revocation. This includes identity-verification failures such as unavailable Google signing keys, invalid identity claims or a missing identity token: the attempt becomes **NEEDS_REVOCATION**, with an encrypted revocation-only token that cannot execute requests or refresh credentials. If no refresh token was issued, cleanup uses the access token. Run `weldall connections cancel <attempt-id>`; failed cancellation retains the token for an explicit retry. An interrupted exchange may have created a grant even if no tokens reached storage; remove such access in Google account settings. Stuck attempts are not automatically discarded. Administrators can remove them, together with their stored payloads, by deleting their connection or connector; connector deletion also removes initial setup attempts that have not created a connection.

The admin overview shows connection/account, owner, connector, status and last use. Search by connection, account or owner and filter by status or connector; filters apply to the 200 most recent connections and are kept in the URL. Open a row for the connection's identity, selected and granted permissions, connection readiness, usage and timestamps. Each detail page has a red **Delete connection** action. After confirmation it atomically removes the connection, linked authorization attempts and encrypted credentials from Weldall, without contacting the provider or decrypting tokens. **Delete connector** in the connector configuration removes all its connections, attempts, encrypted payloads and configuration, including its stored OAuth client secret. Audit records are preserved. IaC connector deletion uses the same local cascade; dependent connections and unfinished attempts do not block it.

**Deletion does not revoke provider access.** Ask owners to use CLI disconnect first if best-effort revocation is desired, or remove access at the provider. Removing the OAuth application in the provider's administration console may affect other users and applications sharing that client; existing tokens may remain valid according to the provider's policies. Once credentials are deleted, Weldall cannot retry revocation.

Administrative deletion does not wait for refreshes or authorization exchanges. Late results cannot recreate deleted connections, attempts or encrypted credentials, including when a connector key is reused. New requests fail after local deletion; in-flight requests may still finish. Unlike administrative deletion, the optional owner/CLI disconnect flow retains its in-flight processing guard so it can attempt revocation of newly issued tokens.

## Encryption and restoration

There are exactly two encryption modes:

- **Fixed application encryption:** `WELDALL_CREDENTIAL_ENCRYPTION_KEY` directly encrypts login/OIDC client secrets, login authorization-attempt payloads, group-provider passwords/tokens, and configured connector OAuth client secrets with AES-256-GCM. These values do not use envelope encryption.
- **Connector envelope encryption:** each write generates a fresh random 32-byte data encryption key (DEK) and encrypts the complete credential object (access token, refresh token, expiry and granted scopes) with AES-256-GCM. Token refresh replaces the whole object with a new DEK. Sensitive connector authorization-attempt payloads use the same envelope path. `WELDALL_CONNECTOR_KEK` wraps each DEK with AES-256-GCM using its own fresh nonce; it never directly encrypts provider credentials. All `LOCAL_ENV` connectors share this deployment KEK, but no records or writes share DEKs. Only ciphertext, wrapped DEKs and authenticated metadata are persisted, never plaintext DEKs.

Both encryption layers bind stable entity IDs and purposes, not mutable display names. Missing, malformed or replaced key material fails closed. Production readiness checks validate stored connector secrets and envelopes before serving traffic. There is **no rotation support** for fixed application encryption or the initial local envelope provider, and an existing connector cannot switch providers. Do not replace either environment key to attempt rotation.

Restore the database **and its corresponding, separately protected deployment secrets** together. Loss or replacement of either environment key makes the corresponding secrets unavailable; a database-only backup cannot restore usable connections. Never generate fallback keys. This protects against database-only disclosure, not compromise of the application process or environment.

Atlassian Cloud, endpoint allow/deny policy, response streaming, administrator-configured origins, runtime plugins, external connector discovery, connection IaC management and connection sharing are not implemented. There are no provider credentials in CLI storage, compatibility endpoints, leases or background maintenance services.
