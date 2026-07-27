# Scope-Katalog (Entwurf) — Gesamtliste aus dem seibert-skills-Sweep

Dieses Dokument ist die Gesamtliste der Scopes aus zwei Quellen (beide Stand Juli 2026): einem vollständigen Durchgang durch das interne `seibert-skills`-Repo (über 300 SKILL.md in `skills/`, `teams/` und `bundles/` — jeder Scope daraus hat mindestens einen existierenden Anwendungsfall) und dem ISO-Systeminventar in SeaTable (Workspace „ISO Taskforce", Base „Asset DB", Tabelle `Softwareinstanz` mit 454 aktiven Einträgen inklusive Schutzbedarf-Klassifizierung — Ergänzungen daraus im eigenen Abschnitt unten). Konventionen und Musterklassen stehen in `scopes-skills-anwendungsfaelle.md`; dieses Dokument ist die kanonische Scope-Liste, die Auswahl im Hauptdokument ist illustrativ.

Beschreibungen folgen der Seed-Konvention: knappe englische Imperativsätze.

**Formatprüfung gegen die DB-Constraints:** Alle Keys in diesem Katalog sind gegen die bestehende `Scope_key_format`-Constraint (Migration `0005`, genau ein Doppelpunkt) valide — die Objektebene steht per Punkt im zweiten Segment (`personio:me.read`, `billomat:invoices.complete`). Bindestriche in Resource-Namen (`atlassian-marketplace:…`) sind erlaubt, Beschreibungen bleiben unter dem 500-Zeichen-Limit, und alle vorgeschlagenen Skill-Slugs bestehen die `Skill_slug_format`-Prüfung aus Migration `0007`.

Legende Musterklasse: **M1** = Upstream-API kann Scoping (mappen), **M2** = Upstream kann kein Scoping (Weldall-Adapter ist die Scoping-Schicht). **M3** ist keine eigene Klasse, sondern der Migrationsstatus „heute Gateway/Whitelist oder geteilter Token, abzulösen" — das Zielbild ist immer M1 oder M2.

## CRM und Vertrieb

### HubSpot (M1-Zielbild, native OAuth-Scopes vorhanden; Status M3 — heute Agent-Gateway-Key `vk_*` org-weit in `~/.zshrc`, daneben persönliche Private-App-Tokens in lokalen Dateien)

| Scope | Beschreibung |
|---|---|
| `hubspot:contacts.read` | Read contacts and their associations. |
| `hubspot:contacts.write` | Create and update contacts. |
| `hubspot:contacts.merge` | Merge duplicate contacts. |
| `hubspot:companies.read` | Read companies. |
| `hubspot:deals.read` | Read deals and pipelines. |
| `hubspot:deals.write` | Create and update deals. |
| `hubspot:tickets.read` | Read service tickets. |
| `hubspot:notes.write` | Create notes and engagements. |
| `hubspot:emails.read` | Read 1:1 and marketing emails. |
| `hubspot:lists.read` | Read contact lists. |
| `hubspot:workflows.enroll` | Enroll contacts in workflows. |

`hubspot:emails.read` bewusst separat — Mailinhalte sind deutlich sensibler als CRM-Stammdaten (heute braucht das einen zweiten PAT mit `sales-email-read`).

### Moco (M1-nah — heute persönliche API-Keys, teils direkt in Skill-Dateien eingeklebt)

| Scope | Beschreibung |
|---|---|
| `moco:activities.read` | Read time entries, projects, and utilization. |
| `moco:activities.write` | Create and edit time entries. |
| `moco:activities.delete` | Delete time entries. |
| `moco:attendances.write` | Create attendances. |
| `moco:companies.write` | Create company records. |

### Heyo Live-Chat (M2 — heute Token aus persönlichem 1Password-Vault des Skill-Autors)

| Scope | Beschreibung |
|---|---|
| `heyo:conversations.read` | Read chat conversations. |
| `heyo:messages.send` | Send messages to visitors. |

`heyo:messages.send` = Außenwirkung; der Skill verbietet das heute per Konvention — Weldall macht daraus eine technische Grenze.

## Finance

### Billomat (M2/M3 — heute Mix aus persönlichen Keys, TeamVault-Eintrag „Billomat API", macOS Keychain, sogar UI-Login per Playwright)

| Scope | Beschreibung |
|---|---|
| `billomat:clients.read` | Read clients. |
| `billomat:invoices.read` | Read invoices. |
| `billomat:invoices.create` | Create draft invoices. |
| `billomat:invoices.complete` | Complete invoices (irreversible booking). |
| `billomat:offers.read` | Read offers. |
| `billomat:offers.create` | Create draft offers. |
| `billomat:offers.complete` | Complete offers. |
| `billomat:articles.write` | Update articles, revenue accounts, and cost centers. |
| `billomat:comments.write` | Add comments to records. |

`*.complete` ist der Festschreibe-Commit — heute nur per Konvention („User fragt vorher") geschützt.

### Seibert Documents / CDB-Belegserver (M2 — heute Basic Auth aus geteiltem TeamVault-Secret pro Umgebung)

Der `cdb-receipt-api`-Skill existiert bereits und belegt den Bedarf:

| Scope | Beschreibung |
|---|---|
| `documents:receipts.read` | Read own submitted receipts and their status. |
| `documents:receipts.create` | Upload receipts with metadata. |
| `documents:receipts.classify` | Update receipt metadata and classification. |
| `documents:archive.read` | Search the full receipt archive. |

### DATEV (Brogrammers-API-Server; heute existiert keine API-Automatisierung — alle Skills bauen EXTF-Dateien für manuellen Import oder lesen den BigQuery-Spiegel)

| Scope | Beschreibung |
|---|---|
| `datev:accounts.read` | Read chart of accounts and balances. |
| `datev:postings.read` | Read posting records. |
| `datev:postings.create` | Submit posting batches. |
| `datev:exports.read` | Read existing exports. |

### Stripe (M2 — heute persönlicher API-Key aus dem Dashboard, lokal abgelegt)

| Scope | Beschreibung |
|---|---|
| `stripe:payouts.read` | Read payouts and transactions. |

### Heimdall (M2 — heute ein org-weiter shared `HEIMDALL_REPORT_SECRET`)

| Scope | Beschreibung |
|---|---|
| `heimdall:streams.register` | Register data streams in the catalog. |
| `heimdall:reports.send` | Send success and failure pings. |

### BWA / Kennzahlen (DWH-gestützt)

| Scope | Beschreibung |
|---|---|
| `finance:reports.read` | Read BWA and KPI reports without document access. |

Aggregat-Scope für den größeren Kreis: Auswertungen ja, Belege und Buchungssätze nein.

## Support

### FreeScout (M2 — heute geteilter API-Key der Instanz)

| Scope | Beschreibung |
|---|---|
| `freescout:tickets.read` | Read and search tickets. |
| `freescout:notes.write` | Add internal notes and draft replies. |
| `freescout:replies.send` | Send replies to customers. |

`freescout:replies.send` ist die Außenwirkungs-Grenze — Entwürfe flächig, Senden eng.

## Atlassian

### Jira Cloud (M1 — heute persönliche API-Tokens in Env-Vars/Dateien oder Rovo-MCP-OAuth)

| Scope | Beschreibung |
|---|---|
| `jira:issues.read` | Read and search issues. |
| `jira:issues.write` | Create and update issues. |
| `jira:issues.comment` | Comment on issues. |
| `jira:issues.transition` | Transition issue status. |

Separate Instanz `help-seibertmedia.atlassian.net` (Helpdesk) würde eine eigene Resource mit denselben Aktionsscopes.

### Confluence Cloud (M1 — wie Jira)

| Scope | Beschreibung |
|---|---|
| `confluence:pages.read` | Read and search pages. |
| `confluence:pages.write` | Create and update pages. |

Space-Grenzen (z. B. FIN) im MVP über den Benutzerkontext der Resource, nicht als eigene Scopes.

### Atlassian Marketplace / Developer Console (M1 — heute persönliche Tokens)

| Scope | Beschreibung |
|---|---|
| `atlassian-marketplace:reports.read` | Read app sales, evaluations, and attribution reports. |

## Plattform und Identität

### CSG-Portal (M1-nah — API hat bereits vier diskrete Permission-Grants; heute Token ad hoc vom User erfragt)

| Scope | Beschreibung |
|---|---|
| `csg:users.read` | Query and list portal users. |
| `csg:users.provision` | Provision users. |
| `csg:attributes.write` | Write user attributes. |
| `csg:wonderlinks.create` | Create wonderlinks. |
| `csg:bans.write` | Manage bans. |
| `csg:audit.read` | Read audit logs. |

### Personio (M1 — heute gar nicht agentisch angebunden; scoped API-Tokens vorhanden)

| Scope | Beschreibung |
|---|---|
| `personio:me.read` | Read own master data, leave balance, and absences. |
| `personio:absences.create` | Create leave and absence requests. |
| `personio:attendances.write` | Maintain own attendance records. |
| `personio:employees.read` | Read team overview. |
| `personio:documents.read` | Read own documents and payslips. |

Leuchtturm-Use-Case, Begründung im Hauptdokument.

## Infrastruktur und Entwicklung

### Coolify (M2 — heute Team-API-Tokens in `.env.local`)

| Scope | Beschreibung |
|---|---|
| `coolify:apps.read` | Read apps, deployments, and status. |
| `coolify:apps.write` | Create apps and configure environments. |
| `coolify:deployments.trigger` | Trigger deployments. |
| `coolify:secrets.write` | Rotate app secrets. |

### n8n (M2 — heute persönliche API-Keys gegen die zentrale Instanz; einzelne Webhooks laufen komplett unauthentifiziert hinter VPN)

| Scope | Beschreibung |
|---|---|
| `n8n:workflows.read` | Read workflows, executions, and errors. |
| `n8n:workflows.write` | Push, activate, and deactivate workflows. |
| `n8n:workflows.execute` | Trigger workflow webhooks. |

`n8n:workflows.execute` würde die heute unauthentifizierten internen Webhooks ablösen.

### Forgejo (M1 — heute persönliche Tokens in `.env.local`)

| Scope | Beschreibung |
|---|---|
| `forgejo:repos.read` | Read repositories. |
| `forgejo:repos.create` | Create repositories from templates. |
| `forgejo:pulls.write` | Create and update pull requests. |
| `forgejo:pulls.merge` | Merge pull requests. |

### npm-Registry / GitHub Packages (M2 — heute ein org-weiter `NPM_TOKEN` aus TeamVault auf jeder Entwicklermaschine)

| Scope | Beschreibung |
|---|---|
| `npm:packages.read` | Install private @seibert packages. |

### Cloudflare (M2 — heute geteilter Org-Token in `~/.claude/.env`)

| Scope | Beschreibung |
|---|---|
| `cloudflare:tunnels.write` | Create tunnels and access policies. |

### Data Warehouse / BigQuery (M1 — heute per-User-IAM; für Agenten interessant wegen Audit und einheitlichem Zugang)

| Scope | Beschreibung |
|---|---|
| `dwh:queries.read` | Run read-only queries against the warehouse. |

## Marketing und Kommunikation

### Reddit Ads (M2 — heute geteilte TeamVault-OAuth-Creds, ein Vollzugriffs-Token für alle; CAPI-Write-Token ebenfalls geteilt)

| Scope | Beschreibung |
|---|---|
| `reddit:ads.read` | Read campaign performance reports. |
| `reddit:ads.write` | Create and update campaigns. |
| `reddit:conversions.send` | Send conversion events. |

### YouTube (M2/M1 — heute geteilte Channel-OAuth-Tokens für die Firmenkanäle)

| Scope | Beschreibung |
|---|---|
| `youtube:videos.upload` | Upload videos as private drafts. |
| `youtube:videos.publish` | Publish videos and set visibility. |

### Cloudinary (M2 — heute geteilter Org-Account-Key in `~/.claude-secrets`)

| Scope | Beschreibung |
|---|---|
| `cloudinary:assets.write` | Upload and replace media assets. |

### PostHog (M2 — heute persönliche API-Keys bzw. credential-lose Client-Captures)

| Scope | Beschreibung |
|---|---|
| `posthog:events.read` | Read events and insights. |
| `posthog:events.capture` | Capture custom events. |

### seibert.link / YOURLS (M2 — persönliche Signature-Tokens)

| Scope | Beschreibung |
|---|---|
| `yourls:links.create` | Create short links. |
| `yourls:stats.read` | Read link statistics. |

### SeaTable (M2 — heute langlebige Base-Tokens in Env-Vars; Granularität ist pro Base)

| Scope | Beschreibung |
|---|---|
| `seatable:rows.read` | Query rows via SQL API. |
| `seatable:rows.write` | Create and update rows. |

Offene Frage: Base-Ebene in den Scope (`seatable:kundenreferenzen.write`) oder in die Resource-Registrierung (eine Resource pro Base). Ich tendiere zu Resource pro Base, Aktions-Scopes generisch — mit einem Vorbehalt: Das Request-Matching der Resource Registry arbeitet über eindeutige URL-Präfixe, und bei SeaTable teilen sich alle Bases denselben Host (die Base steckt in Pfad/Token). Ob „Resource pro Base" damit überhaupt funktioniert oder die Base doch in den Scope muss, ist vor der Anbindung zu klären. Bei Wordpress stellt sich die Frage nicht: eigene Hostnames pro Instanz erzwingen Resource pro Instanz mechanisch.

### INWX (M2 — heute Env-Var-Credentials)

| Scope | Beschreibung |
|---|---|
| `inwx:domains.read` | Check availability and list domains. |
| `inwx:domains.register` | Register domains (paid commitment). |

### Didit (M2 — heute geteilter Business-Account-Key)

| Scope | Beschreibung |
|---|---|
| `didit:checklists.read` | Read checklist instances and templates. |
| `didit:checklists.write` | Create instances and update tasks. |

## Produktivität

### Reclaim.ai (M2 — heute persönlicher API-Key in Env-Var)

| Scope | Beschreibung |
|---|---|
| `reclaim:tasks.read` | Read scheduled tasks. |
| `reclaim:tasks.write` | Create and update tasks. |

## Ergänzungen aus dem ISO-Systeminventar

Das ISO-Inventar listet 454 aktive Softwareinstanzen — weit mehr, als agentisch relevant ist. Ausgefiltert: Desktop-Tools, reine SaaS-Logins ohne API-Anwendungsfall, Infrastruktur unterhalb der API-Ebene (Postfix, LDAP-Server, Kubernetes-Cluster, Netzwerk). Übrig bleiben Systeme mit API und plausiblem Agenten-Anwendungsfall, die im Skill-Sweep nicht auftauchten. Der Schutzbedarf aus dem Inventar (1–3) ist ein guter Default für die Vergabe-Metadaten: Schutzbedarf 3 → nie Self-Service ohne Regelprüfung.

| Scope | Beschreibung | Anmerkung |
|---|---|---|
| `mailchimp:campaigns.read` | Read campaigns and reports. | Schutzbedarf 3 |
| `mailchimp:campaigns.send` | Send campaigns. | Außenwirkung |
| `moss:receipts.read` | Read receipts and their match status. | ergänzt die Belegkette (Moss Belegfinder existiert) |
| `moss:receipts.submit` | Submit receipts. | heute per Mail-Einreichung aus persönlichem Postfach |
| `erpnext:records.read` | Read master data records. | Stammdatensystem, Schutzbedarf 3 |
| `erpnext:records.write` | Create and update master data records. | |
| `pretix:orders.read` | Read ticket orders and attendees. | Schutzbedarf 3 |
| `pretix:events.write` | Create and update events. | |
| `calendly:events.read` | Read scheduled events. | Schutzbedarf 3 |
| `aircall:calls.read` | Read call logs and recordings metadata. | Schutzbedarf 3 |
| `twilio:sms.send` | Send SMS messages. | Außenwirkung |
| `typeform:responses.read` | Read form responses. | |
| `wordpress:posts.write` | Create and edit draft posts. | eine Resource **pro Instanz** — 18 aktive Wordpress-Instanzen (Stand Juli 2026), ein Adapter |
| `wordpress:posts.publish` | Publish posts. | Außenwirkung |
| `miro:boards.read` | Read boards. | Schutzbedarf 3 |
| `miro:boards.write` | Create and update board content. | |
| `seafile:files.read` | Read and download files. | Schutzbedarf 3 |
| `seafile:files.write` | Upload and update files. | |
| `sentry:issues.read` | Read error issues and events. | |
| `grafana:dashboards.read` | Read dashboards and metrics. | |
| `icinga:alerts.read` | Read monitoring status and alerts. | Schutzbedarf 3 |
| `nexus:artifacts.read` | Read and download artifacts. | analog `npm:packages.read` |
| `github:repos.read` | Read repositories, pull requests, and checks. | heute per-User `gh`-Auth — Tranche 3 |
| `github:pulls.write` | Create and update pull requests. | |
| `semrush:reports.read` | Read SEO reports. | ebenso `ahrefs:reports.read` |

**Elewom-Fund.** Die Asset DB enthält die Tabellen `Elewom-User`, `Elewom-Groups` und eine Base „Standard Rights Configurations" — Elewom ist unser bestehendes Rechte-Mapping (Gruppen → Standard-Berechtigungssets pro System). Das ist der natürliche Andockpunkt für die Scope-Vergabe: Weldall-Scope-Sets könnten als Teil der Elewom-Standardsets definiert werden, und der @helpme-Bot schreibt dann beides konsistent — Gruppenmitgliedschaft in Elewom, Scope-Assignment in Weldall. Verdient ein eigenes Konzeptdokument, sobald die @helpme-Kopplung konkret wird.

**Inventar als Resource-Registry-Abgleich.** Das ISO-Inventar ist außerdem die Referenz, gegen die die Weldall Resource Registry periodisch abgeglichen werden sollte: Jede registrierte Resource muss einer aktiven Softwareinstanz entsprechen (samt Owner und Schutzbedarf), und agentisch erschlossene Systeme sollten im Inventar als solche markiert werden.

## Bewusste Nicht-Kandidaten

- **Google Workspace (Gmail, Drive, Docs, Sheets, Calendar, Chat)** — läuft heute durchgängig über persönliches OAuth pro Mitarbeiter. Das ist bereits benutzerbezogen und auditierbar; Weldall brächte hier zunächst wenig. Eine offene Flanke bleibt: Die Außenwirkungs-Grenze (Mail *senden* vs. *entwerfen*) ist per OAuth nur gewahrt, wenn Send-Tools wie der `drip`-Cold-Outreach oder `google-content-radar` tatsächlich mit `gmail.compose` statt `gmail.send`/Voll-Scope laufen — das ist zu prüfen und, falls nicht, ein echter Weldall-Kandidat statt „perspektivisch".
- **Telegram** — persönlicher Account, per Definition per-User.
- **LinkedIn / Xing** — keine API im Einsatz; Publishing ist immer manuell.
- **TeamVault / 1Password** — Verteilmechanismen, keine Zielsysteme. TeamVault hat mit `teamvault-cli` bereits eine read-only Agenten-CLI; sie ist der heutige Weg, geteilte Secrets in Sessions zu holen — und damit genau die Schnittstelle, die Weldall Resource für Resource überflüssig macht. Übergangsweise bleibt sie der Zugang für alles, was noch keine Weldall-Resource ist.
- **Agent-Gateway** — wird von Weldall abgelöst, nicht angebunden.

## Priorisierung

Sortierlogik der Tranchen: Sicherheitsgewinn, also geteilte Credentials × Schreib-/Außenwirkung zuerst. Quer dazu gilt Wert-pro-Aufwand — deshalb bleibt Personio trotz Tranche 2 der erste Leuchtturm-Kandidat: Es betrifft alle Mitarbeitenden, und der Funktionsgewinn schlägt dort den Risikoabbau. Innerhalb von Tranche 1 lohnt zudem die Unterscheidung nach Adapter-Aufwand: npm oder Cloudflare sind fast reine Token-Remaps, Reddit oder Billomat echte M2-Neubauten.

1. **Tranche 1 — geteilte Tokens mit Schreib- oder Außenwirkung:** Reddit, HubSpot (Gateway), Billomat, Seibert Documents/CDB, Cloudinary, Didit, Heimdall, YouTube, Cloudflare, npm. Hier ist der Sicherheitsgewinn am größten.
2. **Tranche 2 — neue Fähigkeiten, die es agentisch noch nicht gibt:** Personio, DATEV-API-Server. Hier ist der Funktionsgewinn am größten.
3. **Tranche 3 — heute schon per-User, Gewinn = Audit + Offboarding + kurzlebige Tokens:** Jira, Confluence, Moco, n8n, Forgejo, Coolify, SeaTable, Stripe, CSG, PostHog, YOURLS, INWX, Reclaim, DWH.

Zählstand dieses Entwurfs (Stand Juli 2026): gut 110 Scopes über rund 45 Resources — genug, um die Konventionen zu validieren, und klein genug, um den Katalog von Hand zu kuratieren.
