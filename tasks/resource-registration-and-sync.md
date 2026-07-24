# Datenbankgestützte Resource Registry und sichere Request-Auflösung

## Status

Geplant. Dieses Dokument ersetzt den bisherigen Vorschlag mit statischen YAML-Dateien und einem späteren `weldall up`.

## Entscheidung

PostgreSQL wird die Quelle der Wahrheit für Downstream-Resources. Administratoren pflegen Resources im bestehenden Weldall-Admin-Bereich. Skills bleiben agentenlesbare Markdown-Anleitungen und enthalten konkrete Request-URLs, sind aber keine vertrauenswürdige Quelle für OAuth-Audiences, Authorization Server oder unterstützte Scopes.

Die offizielle CLI darf DPoP-Tokens und Request-Daten ausschließlich an registrierte URL-Bereiche senden. Eine beliebige HTTPS-URL reicht nicht mehr aus.

## Ausgangslage

Weldall kennt aktuell nur den Expenses-Service. Seine Sicherheitskonfiguration ist an mehreren Stellen hart codiert:

- Resource-Name,
- Resource-Identifier,
- Authorization Server,
- Downstream Client-ID,
- unterstützte Scopes.

Die CLI wählt die Resource derzeit ausschließlich anhand der angeforderten Scopes. Anschließend akzeptiert sie jede syntaktisch gültige HTTPS-Ziel-URL. Dadurch kann beispielsweise ein für Expenses ausgestelltes, DPoP-gebundenes Access Token an einen fremden HTTPS-Host gesendet werden.

Audience und DPoP verhindern zwar eine Wiederverwendung des Tokens beim echten Expenses-Service, der fremde Host erhält aber trotzdem Token-Claims, Benutzerinformationen, Scopes und mögliche Request-Daten. Dieses Verhalten wird im Rahmen der Resource-Registry-Umstellung beseitigt.

## Ziele

- Mehrere Downstream-Resources ohne Codeänderung registrieren können.
- Resource-Konfiguration über den Admin-Bereich verwalten.
- Globale Scopes mehreren Resources zuordnen können.
- Resource-Definitionen und Benutzer-Grants strikt trennen.
- Die Ziel-URL vor jedem Token Exchange einer registrierten Resource zuordnen.
- Token und Request-Daten niemals an nicht registrierte Zielbereiche senden.
- Bestehende Expenses-Grants, Skills und Requests migrieren.
- Änderungen versionieren und auditieren.

## Nicht-Ziele

- Kein OpenAPI- oder Endpunktkatalog.
- Keine automatische Scope-Auswahl aus Endpunktdefinitionen.
- Keine automatische Discovery oder serverseitige Abfrage fremder URLs.
- Kein `weldall up` im ersten Schritt.
- Kein Resource-Ownership-Modell im MVP.
- Keine Secrets oder privaten Schlüssel in der Registry.
- Kein hartes Löschen von Resources im MVP; Resources werden deaktiviert.

## Verantwortlichkeiten

| Bereich | Verantwortlich für |
| --- | --- |
| Skill Registry | Fachliche Anleitungen, konkrete Request-URLs, Payload-Beispiele |
| Resource Registry | OAuth Resource-Identifier, Authorization Server, Downstream Client-ID, erlaubte Request-Bereiche, unterstützte Scopes |
| Scope Registry | Globale fachliche Berechtigungen und Beschreibungen |
| Assignments | Zuweisung globaler Scopes an Benutzer |
| Zielservice | Prüfung von Audience, Scopes, Access Token und DPoP-Proof |

Skills dürfen die Resource Registry weder überschreiben noch erweitern.

## Datenmodell

Die Better-Auth-Tabelle `OauthResource` bleibt ausschließlich für Weldalls eigene API zuständig. Downstream-Services erhalten separate Tabellen, damit die beiden Konzepte nicht vermischt werden.

### `DownstreamResource`

- `id`: interne stabile ID
- `key`: eindeutiger, nach Erstellung unveränderlicher Schlüssel, z. B. `expenses`
- `name`: Anzeigename
- `resourceIdentifier`: eindeutiger OAuth Resource-Identifier
- `authorizationServer`: HTTPS-Origin des Authorization Servers
- `downstreamClientId`: Client-ID für den ID-JAG
- `enabled`: aktive/deaktivierte Resource
- `version`: optimistisches Locking
- `createdAt`, `updatedAt`
- `createdBy`, `updatedBy`

### `ResourceScope`

Many-to-Many-Verknüpfung zwischen `DownstreamResource` und `Scope`:

- `resourceId`
- `scopeId`
- Unique Constraint auf `(resourceId, scopeId)`

Ein globaler Scope kann von mehreren Resources unterstützt werden:

```text
marketing:events
  ├── crm
  ├── newsletter
  └── analytics
```

Ein Benutzer-Grant für `marketing:events` gilt für jede aktive Resource, die diesen Scope ausdrücklich unterstützt. Das Registrieren einer Resource oder Scope-Verknüpfung erzeugt niemals einen Benutzer-Grant.

### `ResourceRequestPrefix`

Eine Resource besitzt mindestens einen vertrauenswürdigen Request-Bereich:

- `id`
- `resourceId`
- `urlPrefix`: normalisiertes HTTPS-URL-Präfix
- `createdAt`, `createdBy`
- Unique Constraint auf den normalisierten Wert

Beispiel:

```text
Resource: expenses
Request prefix: https://expenses.example.com/api
```

Mehrere Präfixe pro Resource erlauben getrennte API-Basen oder kontrollierte Migrationen. Präfixe verschiedener Resources dürfen sich nicht überschneiden.

## Validierung

### Resource

- `key` verwendet nur Kleinbuchstaben, Zahlen, Punkte, Unterstriche und Bindestriche.
- `resourceIdentifier` ist eine absolute HTTPS-URI ohne Credentials oder Fragment und global eindeutig.
- `authorizationServer` ist ein exakter HTTPS-Origin ohne Pfad, Query, Fragment oder Credentials.
- `downstreamClientId` ist nicht leer und besitzt eine begrenzte Länge.
- System-Scopes wie `weldall:administer` können keiner Downstream-Resource zugeordnet werden.
- Alle Scope-IDs müssen existieren.
- Unbekannte Eingabefelder werden abgelehnt.

### Request-Präfixe

- ausschließlich HTTPS,
- keine Credentials,
- keine Query und kein Fragment,
- kanonischer Origin,
- normalisierter Pfad,
- kein abschließender Slash außer beim Root-Pfad,
- keine identischen oder überlappenden Präfixe zwischen Resources.

Die Prüfung auf Überschneidungen läuft gemeinsam mit Resource-Änderungen in einer serialisierten Transaktion, beispielsweise über einen PostgreSQL Advisory Lock.

## URL-Auflösung in der CLI

Die CLI bestimmt die Resource anhand der vollständigen Ziel-URL, nicht anhand der Scopes.

Beispiel:

```bash
weldall request \
  --scope marketing:events \
  --scope marketing:write \
  https://marketing.example.com/api/events
```

Ablauf:

1. Ziel-URL mit dem standardkonformen URL-Parser normalisieren.
2. Exakten Origin vergleichen.
3. Pfad segmentweise gegen registrierte Präfixe prüfen.
4. Genau eine aktive Resource bestimmen.
5. Prüfen, ob die Resource alle angeforderten Scopes unterstützt.
6. Prüfen, ob der Benutzer alle angeforderten Scopes besitzt.
7. Erst danach den Token Exchange ausführen.
8. DPoP-Proof für die exakte Ziel-URL erzeugen.
9. Request ohne Redirect-Folgen senden.

Pfadbeispiele für das Präfix `https://example.com/api`:

```text
✓ https://example.com/api
✓ https://example.com/api/events
✓ https://example.com/api/events?year=2026
✗ https://example.com/api-attacker
✗ https://other.example.com/api/events
```

Kein Treffer oder mehrere Treffer führen zu einem Fehler, bevor Token Exchange oder Ziel-Request stattfinden:

```text
Error: No registered resource accepts https://foobar.example/test
Hint: Use a URL documented by an available Weldall skill.
```

`--resource` wird nicht benötigt. Die URL wählt die Resource; wiederholte `--scope`-Argumente wählen die benötigten Berechtigungen.

## Registry-Antwort für die CLI

Die bisherige `/api/me/scopes`-Antwort wird aus der Datenbank erzeugt. Pro aktiver Resource enthält sie mindestens:

- `key`
- `name`
- `resourceIdentifier`
- `authorizationServer`
- `downstreamClientId`
- `requestPrefixes`
- `supportedScopes`
- `grantedScopes`

Der Endpoint bleibt für jeden angemeldeten CLI-Benutzer mit dem ohnehin vorhandenen `weldall:scopes`-Scope verfügbar. Benutzer sehen keine zusätzlichen Grants; `grantedScopes` ist weiterhin ausschließlich aus Assignments abgeleitet.

Die freundliche Ausgabe von `weldall scopes` zeigt nur Resource-Name und gewährte Scopes. Technische Registry-Daten erscheinen nur mit `--json`.

## Generischer Token Exchange in Weldall

Der Token Exchange darf keine Expenses-Konstanten mehr verwenden.

Serverseitiger Ablauf:

1. `resource`, `audience`, Client-ID und angeforderte Scopes strikt aus dem Request lesen.
2. Eine aktive `DownstreamResource` mit exakt passendem Resource-Identifier und Authorization Server laden.
3. Unterstützte Scopes über `ResourceScope` laden.
4. Benutzer-Grants unabhängig davon laden.
5. Verlangen, dass jeder angeforderte Scope sowohl unterstützt als auch dem Benutzer gewährt ist.
6. ID-JAG mit dem konfigurierten `downstreamClientId` ausstellen.
7. Resource, Audience, Scopes und DPoP-Key weiterhin kryptografisch binden.

Der Token-Exchange-Server kennt die spätere Request-URL nicht und kann nicht erzwingen, wohin ein veränderter Client sein eigenes Token sendet. Die URL-Präfix-Prüfung schützt Nutzer der offiziellen CLI. Audience- und DPoP-Prüfung im Zielservice bleiben die maßgebliche serverseitige Sicherheitsgrenze.

## Admin-Bereich „Resources“

Neue Navigation:

```text
CLI
Resources
Scopes
Assignments
Skill registry
```

### Übersicht

- Suche nach Key, Name und Resource-Identifier
- Sortierung nach Name und Aktualisierungszeit
- Status „Enabled“ oder „Disabled“
- Anzahl unterstützter Scopes
- Anzahl Request-Präfixe
- Link zur Detailansicht

### Detailansicht

- unveränderlicher Resource-Key
- Anzeigename
- unveränderlicher Resource-Identifier
- Authorization Server
- Downstream Client-ID
- Request-Präfixe
- Multi-Selector für unterstützte Scopes
- Enabled/Disabled-Schalter
- Version und Aktualisierungszeit

### Schreibregeln

- Alle Änderungen erfordern `weldall:administer`.
- Der MVP verwendet das bestehende globale Administrationsmodell.
- Create und Update sind strikt schema-validiert.
- Updates verwenden `expectedVersion`.
- Resources werden nicht hart gelöscht, sondern deaktiviert.
- Deaktivierte Resources werden weder an die CLI ausgeliefert noch für neue Token Exchanges akzeptiert.
- Das Entfernen einer Scope-Verknüpfung löscht keine Benutzer-Grants.
- Das Löschen eines globalen Scopes bleibt blockiert, solange Skills oder Resources ihn referenzieren.

## Audit

Mindestens folgende Events werden geschrieben:

- `resource.created`
- `resource.updated`
- `resource.enabled`
- `resource.disabled`

Audit-Metadaten enthalten:

- Actor und Request-ID,
- Resource-Key und interne ID,
- Version vorher/nachher,
- Resource-Identifier,
- Authorization Server,
- Downstream Client-ID,
- Scope-Keys,
- Request-Präfixe,
- Enabled-Status.

Es werden keine Tokens, DPoP-Proofs, Secrets oder Request-Payloads protokolliert.

## Migration der Expenses-Demo

Eine Migration legt die bestehende Resource an:

```yaml
key: expenses
name: Expenses
resourceIdentifier: https://expenses.seibert.localdev/api
authorizationServer: https://expenses.seibert.localdev
downstreamClientId: weldall-cli-at-expenses
enabled: true
requestPrefixes:
  - https://expenses.seibert.localdev/api
scopes:
  - expenses:read
  - expenses:create
  - expenses:delete
  - expenses:write
```

Die vier vorhandenen Scope-Datensätze und alle Benutzer-Grants bleiben bestehen. Die Migration erzeugt nur Resource-, Präfix- und Join-Datensätze.

Die Expenses-Konstanten dürfen im Demo-Service und in dessen Tests verbleiben. Weldalls Policy- und Token-Exchange-Code importiert sie nach der Migration nicht mehr.

## Umsetzungsreihenfolge

### Phase 1: Datenmodell und Migration

- Prisma-Modelle hinzufügen.
- Constraints und Indizes anlegen.
- Expenses-Resource und Verknüpfungen migrieren.
- Bestehende Better-Auth-Resource unverändert lassen.

### Phase 2: Generische Serverlogik

- `grantsFor` durch datenbankgestützte Registry-Abfragen ersetzen.
- `/api/me/scopes` auf das neue Antwortformat umstellen.
- Token Exchange vollständig generisch machen.
- Expenses-Hardcoding aus Weldall entfernen.

### Phase 3: Sichere CLI-Auflösung

- Registry-Datentypen aktualisieren.
- Ziel-URL vor dem Token Exchange gegen Request-Präfixe auflösen.
- mehrere Scopes weiterhin unterstützen.
- fremde, deaktivierte und mehrdeutige Ziele geschlossen ablehnen.
- technische URL aus der freundlichen `scopes`-Ausgabe entfernen.

### Phase 4: Admin-Oberfläche

- Admin-Service mit Create, Read und Update ergänzen.
- tRPC-Router und Validierung ergänzen.
- Navigation, Tabelle und Detailformular implementieren.
- Audit und optimistisches Locking integrieren.

### Phase 5: Dokumentation und Bereinigung

- Skills und CLI-Beispiele auf registrierte Request-Präfixe prüfen.
- alte statische Policy entfernen.
- Architektur- und Sicherheitsdokumentation aktualisieren.
- spätere Themen wie Ownership, Discovery und `weldall up` als Folgeaufgaben dokumentieren.

## Testplan

### Datenmodell und Admin-Service

- Resource mit mehreren Scopes und Präfixen erstellen.
- denselben Scope mehreren Resources zuordnen.
- doppelte Keys und Resource-Identifier ablehnen.
- System-Scope-Zuordnung ablehnen.
- unbekannte Scope-IDs ablehnen.
- identische und überlappende Präfixe ablehnen.
- stale `expectedVersion` ablehnen.
- Deaktivierung sofort wirksam machen.
- Änderungen vollständig auditieren.
- Resource-Änderung erzeugt niemals Benutzer-Grants.

### Grants und Token Exchange

- zwei Resources unterstützen denselben Scope `marketing:events`.
- ein Benutzer-Grant funktioniert für beide Resources.
- Resource-Identifier und Authorization Server wählen jeweils die richtige Resource.
- mehrere angeforderte Scopes müssen vollständig unterstützt und gewährt sein.
- unbekannte, deaktivierte oder widersprüchliche Resources werden abgelehnt.
- nicht unterstützte und nicht gewährte Scopes werden abgelehnt.
- ausgegebener ID-JAG enthält korrekte Resource, Audience, Client-ID und Scopes.

### CLI-Sicherheitsregressionen

- gültiger Origin und Unterpfad funktionieren.
- Query-Parameter bleiben erlaubt.
- `/api-attacker` passt nicht auf `/api`.
- fremder Origin wird abgelehnt.
- unbekannte Ziel-URL verursacht keinen Token Exchange.
- unbekannte Ziel-URL verursacht keinen ausgehenden Ziel-Request.
- deaktivierte Resource verursacht keinen Token Exchange.
- mehrere `--scope`-Argumente funktionieren weiterhin.
- Redirects werden nicht verfolgt.
- `weldall scopes` zeigt in der freundlichen Ausgabe keine technische Resource-URL.
- `weldall scopes --json` enthält die technischen Registry-Daten.

### End-to-End

- bestehender Expenses-Login und Scope-Flow bleibt erfolgreich.
- GET, POST und DELETE aus dem Expenses-Beispielskill funktionieren.
- Request an einen Request-Catcher oder fremden Host wird vor Token-Ausstellung abgelehnt.
- eine zweite Test-Resource mit einem gemeinsam genutzten Scope wird korrekt ausgewählt.

## Akzeptanzkriterien

- Weldall enthält keine fest codierte Downstream-Resource mehr.
- PostgreSQL ist die Quelle der Wahrheit für Downstream-Resources.
- Administratoren können Resources erstellen, bearbeiten, deaktivieren und Scopes zuordnen.
- Ein Scope kann mehreren Resources zugeordnet sein.
- Resource-Definitionen verändern keine Benutzer-Grants.
- Die Ziel-URL bestimmt eindeutig die Resource.
- Mehrere Scopes pro Request bleiben möglich.
- Die offizielle CLI sendet weder Token noch Request-Daten an nicht registrierte Ziele.
- Pfadgrenzen und Origins werden korrekt geprüft.
- Der Token Exchange akzeptiert ausschließlich aktive, registrierte Resources und unterstützte sowie gewährte Scopes.
- Bestehende Expenses-Grants und Skills funktionieren nach der Migration unverändert.
- Alle Änderungen sind versioniert und auditiert.

## Folgeaufgaben

- Resource-Ownership und delegierte Resource-Administratoren
- `weldall up` mit Plan/Apply-Semantik
- CI- oder Machine-to-Machine-Registrierung
- optionale standardisierte Discovery mit SSRF-Schutz
- kontrolliertes Löschen und Owner-Transfer
