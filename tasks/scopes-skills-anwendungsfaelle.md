# Scopes, Skills und Anwendungsfälle für Weldall

Dieses Dokument beschreibt, welche Scopes, Skills und Anwendungsfälle ich für Weldall sehe und mir vorstellen könnte — bewusst eine Ideensammlung aus Betreiber-/Anwendersicht, kein Implementierungsplan. Es ergänzt `skill-registry.md` (Mechanik der Skills), `resource-registration-and-sync.md` (Resources) und `machine-to-machine-auth.md` (Services ohne Benutzer).

## Leitidee

Weldall ist für mich die zentrale Stelle, an der wir beantworten: **Welcher Mensch darf über welchen Agenten was in welchem System tun — und wie erfährt der Agent, wie das geht?**

Heute lösen wir das mit verteilten API-Tokens (1Password, TeamVault, `.env`-Dateien, Agent-Gateway-Whitelists). Jeder Token ist ein Generalschlüssel, niemand hat den Überblick, Offboarding ist Handarbeit. Mit Weldall wird daraus:

- **Scopes** als benutzerbezogene, zentral verwaltete Berechtigungen mit Audit-Trail,
- **Skills** als kuratierte, agentenlesbare Anleitungen, die genau die Scopes nennen, die sie brauchen,
- **Resources** als vertrauenswürdige Zielsysteme hinter kurzlebigen, DPoP-gebundenen Tokens statt langlebiger Secrets.

Der Agent eines Mitarbeiters kann dann genau das, was der Mitarbeiter darf — nicht mehr, und nachvollziehbar.

## Stand heute (Seed-Daten)

Der Scope-Katalog wird in `packages/db/prisma/migrations/0005_admin_scope_catalog/migration.sql` geseedet und enthält aktuell fünf Einträge:

- `weldall:administer` — „Administer Weldall scopes and email assignments." (`isSystem: true`)
- `expenses:read` — „Read expenses."
- `expenses:create` — „Create expenses."
- `expenses:write` — „Modify expenses."
- `expenses:delete` — „Delete expenses."

Die Beschreibungen sind knappe englische Imperativsätze — eine Konvention, die ich für neue Scopes beibehalten würde. Daneben führt der `weldall-cli`-Client die Identity-Scopes `openid`, `profile`, `email`, `offline_access` und `weldall:scopes` (Migration `0006_cli_identity_scopes`); die sind OAuth-Protokollebene und gehören nicht in den fachlichen Katalog.

Die Skill Registry startet dagegen leer: Migration `0007_skill_registry` legt nur die Tabelle an, es gibt keine Seed-Skills. Die ersten Registry-Inhalte müssen also von uns kommen — die natürliche Quelle dafür beschreibt der nächste Abschnitt. Alles Folgende baut auf diesem Bestand auf.

## Lernquelle: unsere seibert-skills

Wir müssen die Anwendungsfälle nicht erfinden. Im internen `seibert-skills`-Repo (der zentralen Skill-Sammlung der Seibert Group) referenzieren rund 60 Skills (Stand Juli 2026) externe APIs mit geteilten, langlebigen Credentials aus TeamVault, 1Password oder dem Agent-Gateway — HubSpot, Billomat, SeaTable, BigQuery, n8n, Coolify, CSG-Portal, PostHog, Moco, Reddit und mehr. Jeder dieser Skills ist ein bereits validierter Anwendungsfall samt implizitem Scope-Bedarf: Was der Skill tut, ist der Scope, den er bräuchte.

Daraus ergeben sich zwei Musterklassen für die Weldall-Anbindung — plus ein Migrationsstatus, der oft damit verwechselt wird:

1. **Upstream-API kann Scoping** (Personio, auch HubSpot mit seinen nativen OAuth-Scopes): Weldall-Scopes mappen auf die nativen Token-Scopes; der Adapter ergänzt höchstens Selbstbezug.
2. **Upstream-API kann kein Scoping** (Reddit, viele kleinere APIs): Der Weldall-Adapter *ist* die Scoping-Schicht, die upstream fehlt. Der geteilte Token bleibt serverseitig im Adapter und erreicht nie Benutzer oder Agent.
3. **Migrationsstatus „heute Gateway/Whitelist oder geteilter Token"** (HubSpot über agent-gateway, Reddit über TeamVault): keine eigene Architekturklasse, sondern die Markierung, dass der heutige Zugangsweg abzulösen ist. Das Zielbild ist immer Klasse 1 oder 2.

Damit die Klasse-2-Adapter nicht teuer werden: Jeder registrierte Adapter muss laut `resource-registration-and-sync.md` als eigener Downstream-Authorization-Server auftreten (ID-JAG einlösen, DPoP validieren, eigener Key). Das sollte einmal als wiederverwendbare Komponente/Library entstehen, die pro Resource nur parametrisiert wird — sonst baut jeder der ~25 Adapter denselben Mini-AS nach, und „dünner Adapter" bleibt ein leeres Versprechen.

Konkretes Vorgehen, das ich vorschlage: die seibert-skills mit Shared-Credential-Zugriff durchgehen, pro Skill den minimalen Scope-Satz notieren und die besten Kandidaten als erste Einträge in die (leere) Weldall-Skill-Registry überführen. Die seibert-skills sind damit zugleich Anforderungskatalog für den Scope-Katalog und Rohmaterial für die Registry-Inhalte.

Dieser Durchgang ist inzwischen passiert: Die vollständige Scope-Liste steht in [`scope-katalog-entwurf.md`](scope-katalog-entwurf.md) — abgeleitet aus allen seibert-skills plus dem ISO-Systeminventar in SeaTable, mit Ist-Credential-Lage, Musterklasse und Priorisierung in drei Tranchen.

## Scope-Konventionen

Das Muster aus dem Tracer Bullet (`expenses:read`, `expenses:create`, `expenses:write`, `expenses:delete`) trägt weiter. Ich würde es so verallgemeinern:

- `<resource>:<aktion>` als Standard: `read`, `create`, `write`, `delete`.
- Bei sensiblen oder breiten Systemen eine Objektebene dazwischen: `personio:absences.write` ist etwas völlig anderes als `personio:salaries.read`.
- Sonder-Scopes für heikle Aktionen explizit statt in `write` versteckt: `hubspot:contacts.merge`, `billomat:invoices.complete` (Festschreiben), `freescout:replies.send` (nach außen kommunizieren).
- `weldall:administer` bleibt der einzige System-Scope; fachliche Admin-Rechte gehören in die jeweilige Resource.

**Notation:** Die DB-Constraint `Scope_key_format` (Migration `0005`) erlaubt genau einen Doppelpunkt pro Key. Die Objektebene notieren wir deshalb mit Punkt im zweiten Segment — `personio:absences.write`, `billomat:invoices.complete`. Alle Keys in diesen Dokumenten sind damit gegen die bestehende Constraint valide; sollte die Notation später geändert werden, ist das eine Entscheidung am Weldall-Code, nicht hier.

Wichtig ist mir die Trennung **lesen / intern schreiben / nach außen wirken**. Ein Agent, der Tickets zusammenfassen darf, darf damit noch lange keine Kundenmail senden. Diese Grenze sollte immer ein eigener Scope sein.

## Resources und Scopes, die ich mir konkret vorstelle

Geordnet nach dem, was ich zuerst angehen würde. Die Scope-Listen hier sind illustrative Auswahl — kanonisch und vollständig ist [`scope-katalog-entwurf.md`](scope-katalog-entwurf.md).

### Personio (Leuchtturm-Use-Case)

Personio hat bereits **scoped API-Tokens**. Genau die könnten wir über Weldall agentisch an alle Mitarbeitenden exponieren: Ein dünner Personio-Adapter ist die registrierte Resource, Weldall-Scopes mappen auf Personio-Token-Scopes, und der Adapter erzwingt zusätzlich den Selbstbezug („nur eigene Daten"), den Personio-Tokens allein nicht hergeben.

- `personio:me.read` — eigene Stammdaten, Urlaubssaldo, Abwesenheiten
- `personio:absences.create` — Urlaubs- und Abwesenheitsanträge stellen
- `personio:attendances.write` — eigene Zeiterfassung pflegen
- `personio:employees.read` — Teamübersicht (Führungskräfte, People-Team)
- `personio:documents.read` — eigene Dokumente/Lohnabrechnungen abrufen

Damit kann jeder Mitarbeiter seinem Agenten sagen: „Beantrage mir Urlaub vom 3.–7.8." — ohne dass irgendjemand einen Personio-Token in eine `.env` kopiert. Das ist der Fall, mit dem sich Weldall im Unternehmen am schnellsten beweist, weil er alle betrifft und die Berechtigungsfrage trivial ist (jeder darf auf die eigenen Daten).

### HubSpot

Heute läuft Agent-Zugriff über das Agent-Gateway mit Whitelist und geteiltem Key — funktional, aber nicht benutzerbezogen. HubSpot hat selbst granulare OAuth-Scopes, das Zielbild ist also Musterklasse 1 (mappen, nicht nachbauen). Als Weldall-Resource würde der Zugriff pro Person differenzierbar:

- `hubspot:contacts.read` / `hubspot:contacts.write`
- `hubspot:deals.read` / `hubspot:deals.write`
- `hubspot:tickets.read`
- `hubspot:contacts.merge`, `hubspot:workflows.enroll` als explizite Sonderfälle

Sales bekommt Deals schreibend, Marketing Kontakte lesend, und niemand außerhalb sieht Umsatzdaten.

### Finance (Billomat, DATEV, BWA)

- `billomat:invoices.read`, `billomat:offers.read` — Auswertungen, Abgleiche
- `billomat:invoices.create` — Entwürfe anlegen
- `billomat:invoices.complete` — Festschreiben, bewusst separat und eng vergeben
- `finance:reports.read` — BWA-/Kennzahlen-Auswertungen für einen größeren Kreis, ohne Belegzugriff

Hier zeigt sich der Wert der Objektebene: viele dürfen auswerten, wenige dürfen buchen.

### DATEV-API-Server der Brogrammers

Die Brogrammers betreiben einen DATEV-API-Server, der heute für fast niemanden wirklich zugänglich oder nutzbar ist — die Fähigkeit existiert, aber es fehlt der kontrollierte Zugangsweg. Genau dieses Muster („API vorhanden, Zugang ungelöst") ist der Weldall-Idealfall: Der Server wird als Resource registriert, und statt einer Alles-oder-nichts-Freischaltung vergeben wir differenzierte Scopes.

- `datev:accounts.read` — Kontenrahmen, Salden, Kontoblätter für Auswertungen
- `datev:postings.read` — Buchungssätze lesen (Abstimmungen, BWA-Kommentierung, Jahresabschluss-Checks)
- `datev:postings.create` — Buchungsstapel übergeben, eng vergeben
- `datev:exports.read` — vorhandene Exporte abrufen

Damit wird aus einem Insider-Werkzeug eine breit nutzbare Fähigkeit: Finance-Agenten können Abstimmungen und Auswertungen direkt gegen DATEV fahren, ohne dass jemand Serverzugänge oder Rohtokens weiterreicht.

### Seibert Documents (Beleg-Upstream)

Seibert Documents soll der Upstream-Server sein, auf dem alle Belege für die Buchhaltung landen. Über die Weldall-CLI zugänglich gemacht, wird Belege-Einreichen zum Jedermann-Fall und Belege-Lesen zum Finance-Fall:

- `documents:receipts.create` — Beleg einreichen; wie `personio:me.*` ein Scope für praktisch alle Mitarbeitenden
- `documents:receipts.read` — eigene eingereichte Belege und deren Status sehen
- `documents:archive.read` — Belegarchiv durchsuchen (Finance, Betriebsprüfungs-Vorbereitung)
- `documents:receipts.classify` — Metadaten/Zuordnung pflegen (Finance-Agenten)

Zusammen mit dem DATEV-Server entsteht so eine durchgängige agentische Kette: Beleg per Agent einreichen → Finance-Agent klassifiziert → Buchung landet in DATEV — jede Stufe mit eigener Berechtigungsgrenze.

### Reddit Ads (Beispiel für nicht scopbare APIs)

Ein sehr gutes Beispiel: Die Reddit-API erlaubt kein Scoping. Heute liegen die OAuth-Credentials geteilt in TeamVault, und wir müssen denselben Vollzugriffs-Token an alle Mitarbeitenden gleichermaßen herausgeben — wer Kampagnen-Reports ziehen darf, könnte technisch auch Kampagnen ändern oder Conversion-Events senden.

Als Weldall-Resource dreht sich das um: Ein Reddit-Adapter hält den geteilten Token serverseitig, und Weldall vergibt die Differenzierung, die Reddit selbst nicht anbietet:

- `reddit:ads.read` — Reporting und Kampagnen-Analyse (der heutige `reddit-campaign-analysis`-Fall)
- `reddit:ads.write` — Kampagnen anlegen/ändern (das Terraform-style Tooling)
- `reddit:conversions.send` — CAPI-Events senden; Außenwirkung, eng vergeben

Der Rohtoken verlässt den Adapter nie. Das Muster trägt für jede API ohne eigenes Berechtigungsmodell — davon haben wir einige.

### Wissen und Kollaboration (Confluence, Jira)

- `confluence:pages.read` — der Brot-und-Butter-Scope für fast jeden Agenten
- `confluence:pages.write`, `jira:issues.read`, `jira:issues.write`, `jira:issues.transition`

Google Workspace fehlt hier bewusst: Der Zugriff läuft bereits über persönliches OAuth pro Mitarbeiter und ist damit benutzerbezogen — Details und die eine offene Flanke (Mail *senden* vs. *entwerfen*) stehen bei den Nicht-Kandidaten im Katalog.

Space-/Projektgrenzen (`confluence:space-fin.read`) brauchen wir als Scopes voraussichtlich nicht — anders als bei Billomat, wo upstream kein Benutzer-Berechtigungsmodell für Agenten existiert, hat Confluence eigene Space-ACLs, die der Adapter im Benutzerkontext einfach durchreicht. Der Scope regelt, *ob* ein Agent Confluence lesen darf; *was* er sieht, regelt Confluence selbst.

### Support (FreeScout)

- `freescout:tickets.read` — Tickets lesen und zusammenfassen
- `freescout:notes.write` — interne Notizen und Antwortentwürfe
- `freescout:replies.send` — tatsächlich an Kunden senden; die Außenwirkungs-Grenze

### Betrieb und Entwicklung (Forgejo, Coolify, n8n, TeamVault)

- `forgejo:repos.read`, `forgejo:pulls.write`, `forgejo:pulls.merge`
- `coolify:apps.read`, `coolify:deployments.trigger`
- `n8n:workflows.read`, `n8n:workflows.execute`
- TeamVault ist der heutige Gegenspieler: `teamvault-cli` gibt Agenten read-only Zugriff auf geteilte Secrets — benutzerfreundlich, aber am Ende steht immer ein Rohtoken in der Session. Weldall dreht das um: statt das Secret auszugeben, vermittelt es den Zugriff auf das Zielsystem; der Agent sieht den Rohtoken nie. TeamVault bleibt Übergangsweg für alles, was noch keine Weldall-Resource ist

## Skills, die ich mir vorstelle

Skills sind für mich das Onboarding-Material für Agenten: kuratiert, versioniert, serverseitig nach Scopes gefiltert. Beispiele entlang der Resources oben:

- `personio.urlaub-beantragen` — braucht `personio:me.read`, `personio:absences.create`; erklärt Antrags-Payload, Resturlaubs-Check vorab und dass der Antrag den normalen Genehmigungsweg geht
- `personio.urlaubssaldo` — nur `personio:me.read`; der einfachste sinnvolle Skill überhaupt
- `hubspot.kontakt-recherche` — `hubspot:contacts.read`; erklärt Such-Endpunkte und was ein Agent bei Mehrfachtreffern tun soll
- `hubspot.deal-anlegen` — `hubspot:deals.write`; nennt Pflichtfelder, Pipeline-Konventionen und wann ein Mensch draufschauen muss
- `billomat.rechnungsentwurf` — `billomat:invoices.create`; betont, dass Festschreiben ein eigener Scope und ein eigener Schritt ist
- `freescout.ticket-briefing` — `freescout:tickets.read`; wie man ein Ticket samt Historie zu einem Briefing verdichtet
- `freescout.antwort-entwerfen` — `freescout:notes.write`, `hidden: true` für alle ohne Support-Bezug
- `confluence.recherche` — `confluence:pages.read`; CQL-Grundlagen und wie man Fundstellen zitiert
- `coolify.deploy-status` — `coolify:apps.read`; wie man prüft, ob ein Deploy von `main` durch ist
- `reddit.kampagnen-analyse` — `reddit:ads.read`; im Kern eine Übersetzung des bestehenden `reddit-campaign-analysis`-Skills, nur dass die Credentials aus dem Skill verschwinden

Drei dieser Skills sind in [`skill-beispiele.md`](skill-beispiele.md) vollständig ausformuliert — im echten Registry-Format, direkt übernehmbar.

Zwei Eigenschaften der Skill-Registry würde ich dabei gezielt ausnutzen (normative Definition der Sichtbarkeitsregeln: `skill-registry.md`, Abschnitt „Sichtbarkeit"): **`hidden: true`** hält die Skill-Liste jedes Agenten kurz und rollenspezifisch (der Finance-Agent sieht keine Support-Skills), und **fehlende Scopes bei sichtbaren Skills** machen Berechtigungen entdeckbar — der Agent kann seinem Menschen sagen, welchen Scope er beim Admin beantragen müsste.

## Anwendungsfälle

1. **Self-Service HR für alle** — Urlaubssaldo, Abwesenheitsantrag, Zeiterfassung per Agent. Betrifft jeden Mitarbeiter, geringes Risiko, hoher Sichtbarkeitsgewinn. Mein Kandidat für die erste echte Resource nach dem Tracer Bullet.
2. **Token-Ablösung** — überall dort, wo heute langlebige API-Tokens in 1Password/TeamVault liegen und in Sessions kopiert werden, tritt `weldall request` an deren Stelle. Kurzlebig, DPoP-gebunden, pro Benutzer, auditiert.
3. **Scoping-Schicht für scoping-lose APIs** — bei APIs wie Reddit, die kein eigenes Berechtigungsmodell haben, ist der Weldall-Adapter die einzige Stelle, an der Differenzierung überhaupt möglich ist. Aus „ein Vollzugriffs-Token für alle" wird „read für viele, write für wenige, Außenwirkung für fast niemanden".
4. **Rollenbasierte Agent-Arbeitsplätze** — Sales-, Finance-, Support-Agenten unterscheiden sich nur durch Scope-Zuweisungen und die dadurch sichtbaren Skills; die Agent-Konfiguration selbst bleibt generisch.
5. **On-/Offboarding** — Eintritt heißt Scope-Set zuweisen, Austritt heißt Assignments löschen. Alle Agenten-Berechtigungen einer Person sind an einer Stelle sichtbar und widerrufbar, mit Audit-Events.
6. **Vier-Augen-Grenzen technisch erzwingen** — „Entwurf erstellen" und „nach außen senden/festschreiben" sind getrennte Scopes. Man kann Agenten flächig entwerfen lassen und das Auslösen wenigen Menschen vorbehalten.
7. **Automatisierung im Benutzerauftrag** — geplante Agenten und n8n-Workflows, die mit den Scopes ihres Auftraggebers laufen statt mit einem Service-Generalschlüssel; die Grundlagen dafür beschreibt `machine-to-machine-auth.md`.
8. **Berechtigungs-Discovery** — sichtbare Skills mit fehlenden Scopes machen aus „Agent scheitert an 403" ein „Agent nennt den fehlenden Scope und den Weg zum Admin".

## Scope-Vergabe über den @helpme-Bot

Rechte vergibt bei uns der @helpme-Bot — die Weldall-Scope-Vergabe sollte diesen Weg gehen statt einen zweiten Antragskanal zu eröffnen. Die Zusammenarbeit stelle ich mir so vor:

**Vergabe-Metadaten am Scope.** Der Scope-Katalog bekommt pro Scope hinterlegt, wer ihn freigeben darf und unter welchen Bedingungen er im Self-Service herausgegeben werden kann:

```yaml
key: reddit:ads.read
approvers: ["team-marketing-leads"]
selfService:
  rule: "Mitglied im Marketing-Team"
```

```yaml
key: billomat:invoices.complete
approvers: ["team-finance-leads"]
selfService: none   # immer menschliche Freigabe
```

```yaml
key: personio:me.read
approvers: []
selfService:
  rule: "jeder Mitarbeitende"   # Selbstbezug, kein Risiko
```

**Regelwerk für @helpme.** Der Bot liest diese Metadaten und entscheidet dreistufig: Self-Service-Regel erfüllt → sofort zuweisen; Freigeber definiert → Anfrage an die `approvers` routen und nach deren OK zuweisen; weder noch → ablehnen mit Begründung. Die Regeln liegen bei den Scopes in Weldall, nicht im Bot — der Bot bleibt generischer Vollzugsmechanismus.

**Technische Kopplung.** @helpme schreibt Assignments über die Weldall-Admin-API mit einer eigenen Service-Identität (der Fall „Service handelt als eigene Identität" aus `machine-to-machine-auth.md`), eng geschnitten auf Assignment-Verwaltung — nicht mit voller `weldall:administer`-Breite. Jede Bot-Zuweisung erzeugt dieselben Audit-Events wie eine manuelle, plus Verweis auf den auslösenden Antrag.

**Geschlossener Kreis mit der Discovery.** Damit wird aus Use Case 8 ein durchgängiger Flow: Agent stößt auf fehlenden Scope → nennt Scope und Antragsherkunft → Mensch fragt @helpme → Bot prüft Self-Service-Regel oder routet zum Freigeber → Assignment landet in Weldall → Agent kann sofort weiterarbeiten. Berechtigungsvergabe in Minuten statt Ticket-Tagen, ohne die Kontrolle über heikle Scopes aufzugeben.

**Voraussetzungen und bewusste Konflikte.** Dieses Konzept passt absichtlich *nicht* in den heutigen Admin-Zuschnitt — es benennt, was sich dafür ändern müsste: (1) `admin-backend-scope-grants.md` schließt Self-Service-Anträge, Freigabe-Workflows, Gruppen und Workload-Grants derzeit explizit als Nicht-Ziele aus; diese Nicht-Ziele müssten bewusst aufgehoben werden. (2) Die Admin-API ist heute ausschließlich Session-basiertes tRPC mit binärem `weldall:administer` — für den Bot bräuchte es einen entschiedenen Machine-Auth-Pfad zur Admin-Ebene und einen enger geschnittenen Assignment-Scope, beides offene Punkte aus `machine-to-machine-auth.md`. (3) Die `selfService`-Regeln brauchen einen echten Auswerter (naheliegend: das Elewom-Gruppenmodell, siehe Katalog) statt freien Textes. Bis diese drei Entscheidungen gefallen sind, ist dieser Abschnitt Zielbild, nicht Bauplan.

## Was ich bewusst nicht meine

- Kein Anspruch, jedes SaaS-System sofort anzubinden; die Reihenfolge oben ist Wert-pro-Aufwand.
- Keine Feingranularität um ihrer selbst willen: Scopes entstehen, wenn eine echte Berechtigungsgrenze sie braucht, nicht pro Endpunkt.
- Skills bleiben kuratierte Dokumentation durch Admins, keine Autorisierungsinstanz und kein von Benutzern editierbarer Wildwuchs — genau wie in `skill-registry.md` festgelegt.
