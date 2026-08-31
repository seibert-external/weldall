<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/seibert-external/weldall/main/apps/docs/src/assets/weldall.png" />
    <img alt="Weldall CLI" src="https://raw.githubusercontent.com/seibert-external/weldall/main/apps/docs/src/assets/weldall.png" width="364" height="101" />
  </picture>
</p>

<p align="center">
  <strong>Serve AI-agent skills centrally and connect company resources to the right people, groups, and machines.</strong>
</p>

<p align="center">
  <a href="https://github.com/seibert-external/weldall/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" /></a>
  <a href="https://datatracker.ietf.org/doc/html/draft-ietf-oauth-identity-assertion-authz-grant-04"><img alt="ID-JAG Draft-04" src="https://img.shields.io/badge/OAuth-ID--JAG%20Draft--04-8b5cf6" /></a>
  <a href="https://datatracker.ietf.org/doc/html/draft-parecki-oauth-jwt-dpop-grant-01"><img alt="JWT DPoP Grant Draft-01" src="https://img.shields.io/badge/OAuth-JWT%20DPoP%20Grant%20Draft--01-8b5cf6" /></a>
  <a href="https://www.rfc-editor.org/rfc/rfc9449.html"><img alt="RFC 9449 DPoP" src="https://img.shields.io/badge/RFC-9449%20DPoP-2563eb" /></a>
  <a href="https://www.rfc-editor.org/rfc/rfc8252.html"><img alt="RFC 8252" src="https://img.shields.io/badge/RFC-8252%20Native%20Apps-2563eb" /></a>
</p>

---

## What is Weldall CLI?

Weldall CLI is a central access layer between **employees with their agents (like Claude, Copilot, pi, Open Code, ...)** on one side and **company APIs and skills** on the other. It defines, in one place:

1. **Which capabilities agents may use** — published as _skills_ in a central catalog.
2. **Who gets them** — per person, per group, or per machine, configured in the UI or in YAML files.
3. **Where they apply** — each _resource_ (a service or API) defines its own supported permissions and request scope.

Capabilities are defined centrally by administrators. Agents discover what they are allowed to do via the Weldall CLI. Each employee's agent gets its own skill set from the catalog, so you steer what your agents can do centrally and roll out the same workflows consistently across the company.

The **agent never sees an access token.** The local CLI keeps credentials in the operating system's secure credential store and sends short-lived, device-bound (DPoP) requests itself. Captured tokens cannot be replayed on another machine, and every granted or denied request is recorded for audit.

## Who is this for?

- **You run a company (or an IT department)** and a couple of vibe coders are building important apps for it. Instead of letting them sprinkle API tokens all over the place, you get one place to see what those apps can touch and to revoke it again.
- **You serve AI-agent skills centrally** — a federated skill directory, so what your systems can do lives in one catalog. Everyone gets their own directory, based on their permissions.
- **You connect different services to different groups** — some scopes for one team, other scopes for another, all without editing code.
- **You run your own identity provider** — users sign in through the SSO they already use; machines authenticate as their own registered identities, and groups can come from LDAP or Active Directory.
- **You build internal APIs** and don't want to roll your own auth for every one — there's a drop-in resource-server SDK (Fetch, Hono, Next.js, Astro).

## A reference implementation of modern OAuth

Weldall CLI is a reference implementation of the next generation of OAuth for agentic applications: it uses DPoP-bound API requests and ID-JAGs to reduce the risk of credential leaks.

| Standard                                                                                                                                                   | What it provides                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ID-JAG — Identity Assertion JWT Authorization Grant (Draft-04)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-identity-assertion-authz-grant-04) | The authorization server issues a short-lived identity assertion for a specific resource, client, scope set, and device — the core grant that lets an agent act without holding a token. |
| [JWT Authorization Grant with DPoP (Draft-01)](https://datatracker.ietf.org/doc/html/draft-parecki-oauth-jwt-dpop-grant-01)                                | The resource server exchanges the identity assertion for an access token bound to the device key.                                                                                        |
| [RFC 9449 — DPoP (Demonstrating Proof of Possession)](https://www.rfc-editor.org/rfc/rfc9449.html)                                                         | Sender-constrained tokens: a stolen token is useless on another machine.                                                                                                                 |
| [RFC 8252 — OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252.html)                                                                        | Browser-based sign-in for the CLI, with explicit consent.                                                                                                                                |
| [RFC 7636 — PKCE](https://www.rfc-editor.org/rfc/rfc7636.html)                                                                                             | Protects the native authorization code exchange.                                                                                                                                         |
| [RFC 9700 — OAuth Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html)                                                             | Applied throughout the authorization server and client.                                                                                                                                  |

## Screenshots

> Placeholder images — replace these with real screenshots from the running app before release.

![Skill catalog](https://raw.githubusercontent.com/seibert-external/weldall/main/docs/assets/screenshot-skills.png)

_Browse the central skill catalog and see which capabilities exist._

![Assignment policy](https://raw.githubusercontent.com/seibert-external/weldall/main/docs/assets/screenshot-assignments.png)

_Grant scopes to people and groups; the resource still enforces its own policy._

![Resource registry](https://raw.githubusercontent.com/seibert-external/weldall/main/docs/assets/screenshot-resources.png)

_Register downstream services and control where each scope may be used._

## How it works

```text
user + browser ──sign-in──> Weldall authorization server
administrator ──policy/admin──> Weldall web app ──> PostgreSQL
agent ──commands──> local CLI ──grants / ID-JAG──> Weldall
                              └──token exchange + API request──> resource server + @weldall/sdk
machine ──private_key_jwt + DPoP──> Weldall ──machine JWT──> resource server
```

## Core concepts

- **Skill** — human-readable, centrally published instructions that tell an agent _how_ to use a capability and _which_ permissions it needs. Skills that require scopes you don't have can be hidden, or shown so you can see what else exists.
- **Scope** — a global permission key like `expenses:read`. A scope does nothing on its own; it matters only once it's assigned to an identity _and_ supported by a resource.
- **Assignment** — the scopes attached to a person (by email) or a group. Groups and their current memberships are read from an external provider through a small HTTP interface, so scopes can also come from LDAP or Active Directory group membership. The effective set is the union of direct and group grants.
- **Resource** — a registered downstream service contract: its identifier, its supported scopes, and the URL prefixes where they may be used. The service still independently enforces its own routes.
- **Machine client** — a registered machine identity that uses `private_key_jwt` (RFC 7523) and DPoP to obtain short-lived tokens for specific resources.
- **Audit** — granted and denied access requests are recorded, so administrators can see who asked for what, and trace every policy, resource, and skill change.

## Quick start

### Install the local CLI

```sh
npm install --global @weldall/cli@latest
weldall --version
weldall config set-issuer https://weldall.example.com
weldall login
```

Standalone binaries (no Node.js required) are available for Linux x64, Windows x64, and macOS from the [releases page](https://github.com/seibert-external/weldall/releases).

### A typical inspection flow

```sh
weldall status          # who am I, what can I do?
weldall whoami --json
weldall scopes          # which scopes are granted?
weldall skills          # which capabilities are visible?
weldall skills find expense
weldall skills expenses.review
```

### Make an authenticated request

```sh
weldall request --scope expenses:read \
  https://expenses.example.com/api/expenses
```

Every request requires an absolute HTTPS URL and at least one `--scope`; the CLI checks the target against the registered resources before sending anything.

## What's in the box

| Workspace                             | Purpose                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`@weldall/weldall`](apps/weldall/)   | The Next.js authorization server, administration UI, and authenticated chat experience.                  |
| [`@weldall/cli`](apps/cli/)           | Cross-platform CLI: IaC, interactive OAuth login, capability discovery, authenticated requests.          |
| [`@weldall/sdk`](packages/sdk/)       | Resource-server SDK for Fetch, Hono, Next.js, and Astro: verifies DPoP-bound requests, publishes skills. |
| [`@weldall/dev-idp`](apps/dev-idp/)   | A local-only OpenID Connect provider for development.                                                    |
| [`@weldall/expenses`](apps/expenses/) | A demo resource server protected by the SDK.                                                             |
| [`@weldall/docs`](apps/docs/)         | The documentation site (German and English).                                                             |
| [`@weldall/db`](packages/db/)         | The Prisma database package and migrations.                                                              |

## Documentation

- [A complete agent run](apps/docs/src/content/docs/en/agent-run.mdx) — the protocol walkthrough.
- [How to integrate a service](apps/docs/src/content/docs/en/service-configuration.md) — protect your API with the SDK.
- [Machine authentication](apps/docs/src/content/docs/en/machine-authentication.mdx) — machines as first-class identities.
- [Group providers](apps/docs/src/content/docs/en/group-provider-http-interface.md) — read groups and memberships from LDAP or Active Directory environments.
- [`@weldall/sdk` reference](packages/sdk/README.md) — route protection, skill catalogs, framework adapters.
- [Local development](apps/docs/) — set up the full stack on your machine.

## License

Apache-2.0, as declared in the published `@weldall/cli` and `@weldall/sdk` packages.
