# Admin-Backend für Scopes und E-Mail-Zuweisungen

## Ziel

Weldall erhält ein kleines Admin-Backend für zwei Aufgaben:

1. globale Scopes mit unveränderlichem Key und Beschreibung verwalten,
2. normalisierten E-Mail-Adressen eine vollständige Menge dieser Scopes zuweisen.

Die öffentliche Fachsicht bleibt:

```text
email -> scopes[]
```

Zuweisungen dürfen bereits vor dem ersten Login existieren. Beim Login und beim Token Exchange wird die verifizierte Benutzer-E-Mail normalisiert und gegen den aktuellen Datenbankzustand geprüft.

## Scope-Katalog

Ein Scope enthält mindestens:

```text
Scope
├── id
├── key                 global eindeutig und unveränderlich
├── description
├── isSystem
├── version
├── createdAt / updatedAt
└── createdBy / updatedBy
```

Regeln:

- Keys folgen `namespace:permission`, beispielsweise `expenses:read`.
- Keys werden nicht umbenannt; Beschreibungen dürfen geändert werden.
- Das Anlegen eines globalen Scopes registriert ihn nicht automatisch für eine Downstream-Ressource.
- `grantsFor(email)` schneidet zugewiesene Scopes mit den separat unterstützten Resource-Scopes.
- `weldall:administer` ist ein fest angelegter System-Scope und kann über die Anwendung weder geändert noch gelöscht werden.
- Das Löschen eines normalen Scopes entfernt ihn atomar aus allen betroffenen Zuweisungen und auditiert die Änderungen.

## E-Mail-Zuweisungen

Das relationale Modell verwendet ein versioniertes Set und einzelne Grant-Zeilen:

```text
EmailScopeAssignment
├── id
├── normalizedEmail     eindeutig
├── version
├── createdAt / updatedAt
├── createdBy / updatedBy
└── grants[]

EmailScopeGrant
├── assignmentId
├── scopeId
├── createdAt
└── createdBy
```

Regeln:

- E-Mail-Adressen werden getrimmt und kleingeschrieben gespeichert.
- Ein Save ersetzt immer die vollständige Scope-Menge.
- Doppelte Scope-Keys werden entfernt und deterministisch sortiert.
- Unbekannte Scopes lehnen die gesamte Änderung ab.
- Eine leere Scope-Menge ist ein logisches Delete; das versionierte Assignment bleibt als Tombstone bestehen.
- Eine erwartete Version verhindert versehentliches Überschreiben durch veraltete UI-Zustände.

## Administratoren

Admin ist ein verifizierter Benutzer, dessen normalisierte E-Mail den Scope `weldall:administer` besitzt.

- Der erste Admin wird einmalig per Deployment-Befehl angelegt:

  ```bash
  pnpm admin:bootstrap --email alice@example.com
  ```

- Danach vergeben Admins `weldall:administer` über normale E-Mail-Zuweisungen.
- Der letzte verbleibende Admin kann nicht entfernt werden.
- Seiten- und Layout-Gates dienen nur der UX; jede tRPC-Procedure prüft die Adminberechtigung erneut über ein gemeinsames Middleware.

## tRPC-Schnittstelle

Das Admin-Frontend und eventuelle interne Clients verwenden ausschließlich den vorhandenen tRPC-Endpunkt `/api/trpc`.

```text
admin.status
admin.scopes.list
admin.scopes.options
admin.scopes.create
admin.scopes.update
admin.scopes.delete
admin.assignments.list
admin.assignments.replace
admin.assignments.delete
```

Die Procedures verwenden strikte Zod-Inputs. Das gemeinsame `adminProcedure`-Middleware:

1. verlangt eine Better-Auth-Session,
2. lädt den aktuellen verifizierten Benutzer,
3. prüft dessen live `weldall:administer`-Zuweisung,
4. stellt Actor und Request-ID für Mutation und Audit bereit,
5. lehnt fremde Origins bzw. fehlenden CSRF-Header bei Browser-POSTs ab.

Es gibt keine parallele REST-/OpenAPI- oder DPoP-Admin-Schnittstelle.

## Persistenz und Audit

Eine normale Prisma-Transaktion umfasst jeweils die fachliche Mutation und ihre erfolgreichen Audit-Einträge. Assignment-Replacements verwenden direkt Prismas `Serializable`-Isolation, damit zwei gleichzeitige Admin-Entzüge nicht den letzten Admin entfernen. Zusätzliche globale Locks oder eine zweite Transaktionsabstraktion sind nicht vorgesehen.

Ein Audit-Eintrag enthält mindestens:

- Actor-ID und optional Actor-E-Mail,
- betroffenen Scope oder betroffenes Assignment,
- Vorher-/Nachher-Scopes,
- Operation,
- Versionen,
- Zeitpunkt und Request-ID.

Audit-Einträge werden über die Admin-Oberfläche nicht verändert oder gelöscht.

## UI

Die Admin-Oberfläche folgt Fleat und Astryx:

- einklappbare Astryx-Sidebar mit `Scopes` und `Assignments`,
- animierte Herocrumbs mit Reduced-Motion-Fallback,
- Astryx-Tabellenprimitives mit TanStack Table,
- URL-basierte Suche, Sortierung und Pagination mit `nuqs`,
- TanStack Query und die typisierten tRPC Query-/Mutation-Options,
- TanStack Form für Scope- und Assignment-Formulare,
- Astryx Dialoge, MultiSelector, Banner und Delete-Bestätigungen,
- Light-/Dark-Mode.

## Nicht Bestandteil

- Ressourcen- und Endpoint-Registrierung,
- automatische Zuordnung neuer globaler Scopes zu Ressourcen,
- Rollen, Gruppen, Teams oder zeitlich begrenzte Grants,
- Workload-/Machine-to-Machine-Grants,
- Self-Service-Anträge und Freigabe-Workflows,
- Verzeichnis-Synchronisation,
- eine zusätzliche REST-Admin-API.

## Tests

Mindestens abgedeckt werden:

- E-Mail- und Scope-Normalisierung,
- Scope CRUD und Schutz des System-Scopes,
- vollständiges Ersetzen und Löschen von Zuweisungen,
- unbekannte Scopes ohne Teiländerung,
- veraltete Versionen,
- Schutz des letzten Admins,
- kaskadierendes Scope-Löschen inklusive Versions- und Audit-Updates,
- Session-/Admin-Middleware und CSRF-/Origin-Prüfung,
- unmittelbare Wirkung auf `/api/me/scopes` und neue Token Exchanges,
- Browser-E2E für Scopes, Assignments und den bestehenden CLI-Flow.

## Akzeptanzkriterien

- Scopes und E-Mail-Zuweisungen sind persistent und über die Astryx-UI verwaltbar.
- `weldall:administer` ist unveränderlich und steuert alle Admin-Procedures über einen Live-DB-Check.
- Der erste Admin kann gebootstrapped und der letzte Admin nicht entfernt werden.
- Mutationen sind versioniert, strikt validiert und gemeinsam mit ihrem Audit atomar.
- `grantsFor(email)`, `/api/me/scopes` und neue Token Exchanges lesen den aktuellen Datenbankzustand.
- Admin-Kommunikation läuft ausschließlich über tRPC.
