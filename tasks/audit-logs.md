# Audit Logs für ID-JAG-Ausstellung und Scope-Konfiguration

## Problem

Sicherheitsrelevante Vorgänge sind derzeit nicht dauerhaft und strukturiert nachvollziehbar. Insbesondere muss später beantwortet werden können:

- Wer bzw. welcher Client hat wann ein ID-JAG für welche Ressource und welche Scopes erhalten?
- Welche ID-JAG-Ausstellungen wurden abgelehnt und warum?
- Wer hat wann Scope-Grants oder registrierte Scope-Definitionen verändert?
- Wie sah die Konfiguration vor und nach einer Änderung aus?

Normale Application Logs reichen dafür nicht aus. Sie können unstrukturiert, kurzlebig oder unvollständig sein und dürfen zudem keine Tokens oder Secrets enthalten.

## Ziel

Weldall erhält ein persistentes, strukturiertes und append-only behandeltes Audit Log für mindestens:

1. erfolgreiche und abgelehnte ID-JAG-Ausstellungen,
2. Änderungen an Benutzer-Scope-Grants,
3. Änderungen an registrierten Ressourcen und Scope-Definitionen.

Audit-Einträge müssen durchsuchbar und einem Actor sowie einer Request-/Correlation-ID zuordenbar sein, ohne sensible Tokeninhalte zu speichern.

## Ereignistypen

Mindestens folgende Event Types definieren und versionieren:

```text
id_jag.issued
id_jag.denied
user_scopes.created
user_scopes.replaced
user_scopes.deleted
resource_scopes.created
resource_scopes.replaced
resource_scopes.deleted
```

Optional können technische Fehler separat erfasst werden:

```text
id_jag.failed
scope_config.failed
```

Dabei ist die Semantik eindeutig zu dokumentieren:

- `denied`: Anfrage wurde aufgrund einer erwarteten Policy- oder Authentisierungsentscheidung abgelehnt.
- `failed`: Anfrage konnte wegen eines internen oder abhängigen Systemfehlers nicht verarbeitet werden.
- `issued`: Weldall hat ein gültiges ID-JAG erzeugt und zur Auslieferung freigegeben.

## Gemeinsames Audit-Schema

Jeder Eintrag enthält mindestens:

```text
AuditEvent
├── id
├── schemaVersion
├── eventType
├── occurredAt
├── actorType
├── actorId
├── actorEmail?          nur wenn erforderlich
├── clientId?
├── requestId
├── correlationId?
├── outcome
├── reasonCode?
├── subjectType?
├── subjectId?
├── metadata             strikt validiertes JSON
└── createdAt
```

Anforderungen:

- `id` ist global eindeutig und zeitlich nicht wiederverwendbar.
- Zeitstempel werden serverseitig in UTC erzeugt.
- `eventType`, `actorType`, `outcome` und `reasonCode` verwenden kontrollierte, dokumentierte Werte.
- `metadata` besitzt pro Event Type ein eigenes strikt validiertes Schema.
- Unbekannte Felder werden abgelehnt oder vor dem Speichern entfernt.
- Request- und Correlation-IDs werden validiert und dürfen keine beliebigen Log-Inhalte injizieren.
- Das Schema ist versioniert, damit alte Audit-Einträge dauerhaft interpretierbar bleiben.

## Audit der ID-JAG-Ausstellung

Für `id_jag.issued` werden mindestens gespeichert:

- Benutzer-Subject als Actor bzw. delegiertes Subject,
- aufrufender OAuth-Client (`client_id`),
- Ziel-Authorization-Server bzw. Audience,
- Ziel-Resource,
- tatsächlich gewährte, sortierte Scopes,
- ID-JAG-ID bzw. `jti`,
- Ausstellungs- und Ablaufzeitpunkt,
- verwendete Signatur-Key-ID (`kid`),
- DPoP-Key-Fingerprint bzw. JKT nur, wenn dies für Ermittlungen erforderlich und datenschutzrechtlich freigegeben ist,
- Request-/Correlation-ID,
- Ergebnis `success`.

Für `id_jag.denied` werden mindestens gespeichert:

- vorhandene, bereits verifizierte Actor-/Client-Informationen,
- angefragte Resource und Scopes, soweit sicher parsebar,
- stabiler Ablehnungsgrund wie `invalid_client`, `invalid_resource`, `scope_not_granted`, `invalid_dpop_proof` oder `replay_detected`,
- Ergebnis `denied`.

### Niemals speichern

- vollständige ID-JAGs,
- Access Tokens oder Refresh Tokens,
- DPoP-Proofs,
- Authorization Codes,
- private oder symmetrische Schlüssel,
- Client Secrets,
- unbereinigte Request-Header oder Request-Bodies.

Ein Token-Hash soll nur aufgenommen werden, wenn dafür ein klarer Ermittlungszweck besteht. Die `jti` genügt voraussichtlich als nicht geheime Referenz.

## Audit von Scope-Konfigurationsänderungen

Die Task `admin-backend-scope-grants.md` führt zunächst `email -> scopes[]` ein. Jede erfolgreiche Änderung speichert:

- Administrator als Actor,
- betroffene normalisierte E-Mail-Adresse bzw. stabile Benutzer-ID,
- vorherige sortierte Scope-Liste,
- neue sortierte Scope-Liste,
- hinzugefügte und entfernte Scopes,
- Operation (`create`, `replace`, `delete`),
- Request-/Correlation-ID,
- optional ETag bzw. Konfigurationsversion vor und nach der Änderung.

Auch Änderungen am Ressourcen- und Scope-Katalog aus `resource-registration-and-sync.md` müssen auditiert werden:

- Resource Identifier und Owner,
- vorherige und neue Scope-Definitionen,
- hinzugefügte, geänderte und entfernte Scopes,
- Quelle der Änderung, z. B. `admin_api`, `weldall_up`, `static_manifest_import` oder `migration`,
- Manifest-/OpenAPI-Version bzw. Content-Digest,
- Actor oder bei Deployment-Imports eine eindeutige Workload-/Deployment-Identität.

Geheime Endpunktdefinitionen oder vollständige OpenAPI-Dokumente werden nicht unkontrolliert in Audit-Metadaten kopiert. Stattdessen werden sichere Diffs und Content-Digests gespeichert.

## Atomarität und Fehlerverhalten

### Scope-Änderungen

Grant-/Konfigurationsänderung und zugehöriger erfolgreicher Audit-Eintrag werden in derselben Datenbanktransaktion gespeichert. Kann der Audit-Eintrag nicht geschrieben werden, darf die Änderung nicht wirksam werden.

Abgelehnte Änderungsversuche können außerhalb dieser Transaktion als eigenes Event gespeichert werden, dürfen aber keinen falschen erfolgreichen Zustand dokumentieren.

### ID-JAG-Ausstellung

Vor der Umsetzung ist explizit zu entscheiden, ob ID-JAG-Ausstellung bei nicht verfügbarem Audit Store fehlschlagen muss. Für sicherheitskritische Ausstellung wird ein **fail-closed** Verhalten bevorzugt:

1. Anfrage vollständig validieren.
2. Claims und eindeutige `jti` vorbereiten.
3. dauerhaften Audit-Eintrag schreiben bzw. atomar über eine Outbox vormerken,
4. ID-JAG signieren und nur bei erfolgreicher Audit-Persistenz zurückgeben.

Die genaue Event-Semantik muss berücksichtigen, dass eine Netzwerkunterbrechung nach der Persistenz verhindern kann, dass der Client die Antwort erhält. `issued` bedeutet daher „von Weldall erzeugt und zur Antwort freigegeben“, nicht zwingend „vom Client empfangen“.

Ein asynchroner Best-Effort-Log-Aufruf ohne Haltbarkeit ist für `id_jag.issued` nicht ausreichend.

## Speicherung und Unveränderbarkeit

- Audit Events werden in einer eigenen Datenbanktabelle gespeichert.
- Die Anwendungsrolle erhält Insert- und Read-, aber keine regulären Update-Rechte für Audit Events.
- Die Anwendung bietet keine Update- oder Delete-API für einzelne Audit-Einträge an.
- Korrekturen erfolgen ausschließlich durch zusätzliche, referenzierende Events.
- Datenbankmigrationen und administrative Wartung werden getrennt und nachvollziehbar kontrolliert.
- Optional kann später eine Hash-Kette, Signatur oder regelmäßiger Export in unveränderbaren Object Storage Manipulationen erkennbar machen.

„Append-only“ innerhalb der Anwendung schützt nicht gegen privilegierte Datenbankadministratoren. Der gewünschte Manipulationsschutz und die Trust Boundary müssen dokumentiert werden.

## Zugriff auf Audit Logs

Spätere tRPC-Lese-Procedures können beispielsweise bereitstellen:

```text
admin.auditEvents.list
admin.auditEvents.get
```

Filter:

- Zeitraum,
- Event Type,
- Actor,
- Subject bzw. betroffene E-Mail,
- Client,
- Resource,
- Scope,
- Outcome,
- Request-/Correlation-ID.

Anforderungen:

- Zugriff benötigt eine separate Berechtigung wie `weldall:audit:read`; `weldall:administer` impliziert dies nicht automatisch.
- Ergebnisse sind paginiert und stabil sortiert.
- Exporte sind größenbegrenzt und werden selbst auditiert.
- Leser können Audit Events nicht verändern oder löschen.
- Suchparameter und Antworten verhindern unnötige Benutzer- oder Endpoint-Enumeration.

Eine UI ist nicht Bestandteil des MVP; Speicherung und serverseitige Abfrage müssen jedoch so gestaltet sein, dass später ein Admin-Frontend darauf aufbauen kann.

## Datenschutz und Aufbewahrung

Vor dem produktiven Einsatz festlegen und dokumentieren:

- Rechtsgrund und Zweck der Verarbeitung,
- notwendige personenbezogene Felder,
- Aufbewahrungsdauer je Event Type,
- Zugriffsberechtigte,
- Export- und Löschprozess nach Ablauf der Retention,
- Umgang mit Auskunfts- und Löschanforderungen,
- ob IP-Adresse oder User Agent überhaupt benötigt werden.

Grundsatz: so wenig personenbezogene Daten wie möglich speichern. Eine stabile interne Subject-ID ist gegenüber einer E-Mail zu bevorzugen, sofern der Audit-Fall damit verständlich bleibt. Bei Scope-Grants per E-Mail kann eine normalisierte E-Mail erforderlich sein; sie darf nicht zusätzlich unnötig dupliziert werden.

Retention-Löschungen erfolgen kontrolliert und werden als Wartungsvorgang protokolliert, nicht über die normale Admin-API.

## Observability

Audit Logs und operative Logs bleiben getrennt:

- Application Logs helfen beim Betrieb und Debugging.
- Audit Logs dokumentieren sicherheitsrelevante Geschäftsereignisse.
- Metriken dürfen Event-Anzahlen und Latenzen aggregieren, aber keine E-Mails, Subjects oder Scope-Listen als hoch-kardinale Labels verwenden.
- Alarmierung sollte ungewöhnlich viele abgelehnte ID-JAG-Anfragen, Replay-Versuche oder massive Grant-Änderungen erkennen.
- Audit-Write-Fehler erzeugen ein operatives Signal, ohne sensible Eventdaten in normale Logs zu kopieren.

## Migration und Integration

Die Audit-Funktion wird an zentralen Stellen integriert, nicht ad hoc in einzelnen Route Handlern:

- in der maßgeblichen ID-JAG-Ausstellungsfunktion im Weldall OAuth-Facade,
- in der zentralen Grant-/Scope-Konfigurationsschicht,
- in späteren Ressourcenimporten und `weldall up`,
- über eine typisierte `AuditWriter`-Schnittstelle für Tests und alternative persistente Backends.

Bestehende historische Vorgänge können nicht rückwirkend rekonstruiert werden. Der Startzeitpunkt vollständiger Audit-Abdeckung wird dokumentiert.

## Tests

Mindestens folgende Fälle abdecken:

- erfolgreiche ID-JAG-Ausstellung erzeugt genau ein `id_jag.issued`-Event,
- Event enthält Resource, Scopes, Client, Actor, `jti` und `kid`, aber kein Token,
- nicht gewährter Scope erzeugt ein bereinigtes `id_jag.denied`-Event,
- ungültiges DPoP bzw. Replay wird mit stabilem Reason Code auditiert,
- sensible Header, Tokens und Assertions erscheinen in keinem Audit-Feld,
- Scope-Grant-Änderung und Audit Event werden atomar gespeichert,
- fehlgeschlagene Scope-Änderung erzeugt keinen erfolgreichen Audit-Eintrag,
- Ausfall des Audit Stores verhindert bei fail-closed Policy die ID-JAG-Ausstellung,
- doppelte Retries erzeugen keine irreführenden mehrfachen Erfolgsevents,
- Parallelität erhält korrekte Vorher-/Nachher-Diffs,
- nur Benutzer mit `weldall:audit:read` können Audit Events abfragen,
- Pagination und Filter liefern stabile Ergebnisse,
- Audit Events können über die Anwendung weder aktualisiert noch einzeln gelöscht werden.

## Akzeptanzkriterien

- ID-JAG-Ausstellungen und -Ablehnungen werden als strukturierte, persistente Audit Events erfasst.
- Änderungen an Benutzer-Grants sowie Ressourcen-/Scope-Definitionen werden mit Actor und Vorher-/Nachher-Zustand erfasst.
- Kein Audit Event enthält vollständige Tokens, DPoP-Proofs, Secrets oder private Schlüssel.
- Erfolgreiche Scope-Änderung und Audit Event sind atomar.
- Das Fehlerverhalten bei nicht verfügbarem Audit Store ist dokumentiert und für ID-JAG-Ausstellung sicher umgesetzt.
- Event Types, Reason Codes und Metadaten-Schemas sind versioniert und dokumentiert.
- Audit Events sind über die Anwendung append-only und nur mit separater Leseberechtigung zugänglich.
- Retention, Datenschutz, Zugriff und Grenzen des Manipulationsschutzes sind dokumentiert.
- Automatisierte Tests belegen Vollständigkeit, Redaction, Atomarität und Autorisierung.
