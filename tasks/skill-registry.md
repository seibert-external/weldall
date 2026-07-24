# Skill Registry und generische DPoP-Requests

## Entscheidung

Der geplante Endpunktkatalog entfällt. Weldall importiert kein OpenAPI, kennt keine Operation-IDs und leitet Scopes nicht aus HTTP-Pfaden ab.

Stattdessen pflegen Administratoren agentenlesbare Skills. Ein Skill besteht aus Markdown-Instruktionen und normalisiertem Frontmatter:

```md
---
title: "Expensen laden"
requiredScopes:
  - "expenses:read"
hidden: true
---

Lade Expensen mit:

`weldall request --scope expenses:read https://expenses.example/api/expenses`

Das ist wichtig, weil …
```

Die Skill Registry ist vertrauenswürdige, von Administratoren kuratierte Dokumentation. Sie ist keine Autorisierungsinstanz.

## CLI

```bash
weldall skills
weldall skills show expenses.list

weldall request \
  --scope expenses:read \
  https://expenses.example/api/expenses

weldall request \
  --method POST \
  --scope expenses:create \
  --json '{"amount":24}' \
  https://expenses.example/api/expenses
```

`weldall request` verhält sich wie ein kleiner HTTP-Client:

- vollständige HTTPS-URL statt Resource/Path-Kombination,
- `GET` als Standardmethode,
- wiederholbares `--scope`,
- optionale Header sowie Raw- oder JSON-Body,
- Weldall ergänzt DPoP-Authorization und DPoP-Proof,
- keine Abwärtskompatibilität zur alten Request-Syntax.

Die Request-URL wird nicht gegen einen Endpunktkatalog aufgelöst. Sie muss jedoch zu genau einem vertrauenswürdigen URL-Präfix aus der datenbankgestützten Resource Registry passen. Die URL bestimmt dadurch die Resource; die expliziten Scopes bestimmen die angeforderten Berechtigungen. Weldall lehnt fremde oder mehrdeutige Ziele vor dem Token Exchange ab. DPoP bleibt eine zusätzliche kryptografische Bindung und ist kein Ersatz für diese Zielprüfung. Details stehen in `resource-registration-and-sync.md`.

## Sichtbarkeit

`requiredScopes` enthält im MVP ein AND-Set.

- Hat der Benutzer alle Scopes, ist der Skill verfügbar.
- Fehlen Scopes und `hidden: false`, bleibt der Skill sichtbar und nennt die fehlenden Scopes.
- Fehlen Scopes und `hidden: true`, liefert Weldall den Skill nicht aus.
- Die Filterung erfolgt serverseitig.

Scopes im Skill ersetzen keine Prüfung:

1. Weldall stellt nur Scopes aus, die dem Benutzer aktuell gewährt sind.
2. Das Zielsystem validiert Audience, Scopes und DPoP.
3. Skill-Inhalte oder Agent-Ausgaben können diese Prüfungen nicht umgehen.

## Admin-Bereich

Nur Benutzer mit `weldall:administer` dürfen Skills pflegen.

Der Admin-Bereich erhält:

- eine durchsuchbare, sortierbare und paginierte Skill-Tabelle,
- eine Detailansicht zum Erstellen und Bearbeiten,
- TanStack Form mit ASTRYX-Komponenten,
- Felder für stabile Skill-ID, Titel, benötigte Scopes, `hidden` und Markdown,
- optimistisches Locking über `version`,
- Audit-Events für Erstellen, Ändern und Löschen.

Die Skill-ID ist nach dem Erstellen unveränderlich. Speichern veröffentlicht die Änderung unmittelbar; Drafts und Freigabeworkflows sind nicht Teil des MVP.

## API

```http
GET /api/me/skills
GET /api/me/skills/{skillId}
```

Beide Endpunkte verlangen ein DPoP-gebundenes Weldall-Access-Token. Die Listenantwort enthält sichtbare Metadaten, Verfügbarkeit und fehlende Scopes. Die Detailantwort enthält zusätzlich das Markdown und das vollständig zusammengesetzte Dokument inklusive Frontmatter.

## Nicht-Ziele

- OpenAPI-Import oder -Generierung
- Endpunkt-, Parameter- oder Payload-Katalog
- automatische Scope-Auswahl aus URLs
- Ausführung von MDX/JavaScript
- Markdown-Rendering in der CLI
- lokale Skill-Caches
- Skill-Drafts oder Benutzerautoren

## Akzeptanzkriterien

- Administratoren können Skills in Tabelle und Detailansicht erstellen, ändern und löschen.
- Änderungen sind versioniert und auditiert.
- `weldall skills` liefert nur serverseitig sichtbare Skills (`weldall skills list` bleibt ein Alias).
- `weldall skills show <id>` gibt das vollständige, terminal-sichere Markdown aus.
- `hidden` blendet Skills ohne vollständige Scope-Abdeckung vollständig aus.
- `weldall request --scope … <https-url>` akzeptiert nur Ziele einer aktiven registrierten Resource und erzeugt anschließend einen DPoP-Proof für Methode und vollständige Ziel-URL.
- Die alte `request <resource> <method> <path>`-Syntax wird nicht unterstützt.
- Zielservice und Token-Ausstellung bleiben die maßgeblichen Autorisierungsgrenzen.
