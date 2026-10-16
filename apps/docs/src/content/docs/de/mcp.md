---
title: Governed MCP
description: Remote-MCP-Tools und Ressourcen über persönliche oder per Scope geteilte Weldall-Verbindungen verwenden.
---

Weldall vermittelt MCP-Tools und Ressourcen über Streamable HTTP. Die CLI verwendet ausschließlich Weldalls private DPoP-geschützte JSON-API. Provider-Zugangsdaten bleiben verschlüsselt auf dem Server; in Goose bleibt `@weldall/goose` der sichtbare MCP-Server.

## Einrichtung

Lege in der bestehenden Connector-Verwaltung einen **Atlassian MCP**-Connector an oder verwende IaC. Es gibt keine zusätzliche MCP-Server-Konfiguration: Der Connector enthält die Richtlinien, darunter liegen die persönlichen Kontoverbindungen. Endpunkt, OAuth-Client-ID und Client-Secret müssen nicht eingegeben werden.

Für Atlassian wird ein **separater Connector vom Typ `atlassian-mcp`** angelegt. Er verwendet `https://mcp.atlassian.com/v2/mcp`; bestehende Atlassian-REST-Verbindungen bleiben unverändert. Ein vollständiges Manifest findest du in der [englischen MCP-Referenz](../../mcp/). Lege `LOCAL_ENV` oder `OPENBAO` beim Erstellen fest; ein späterer Wechsel oder stiller Fallback ist nicht vorgesehen.

Die erste Kontoverbindung registriert bei Bedarf einen öffentlichen OAuth-Client. IaC-Apply führt keine Registrierung aus. PKCE S256 und `token_endpoint_auth_method: none` benötigen kein Client-Secret. Callback: `https://weldall.example.com/api/connectors/atlassian-mcp/callback` mit deiner Weldall-Domain. Zu den ausgewählten MCP-Berechtigungen kommen `read:me`, `read:account` und `offline_access`.

Atlassian kann weniger Scopes gewähren als angefordert. Weldall akzeptiert und speichert diesen reduzierten Grant, protokolliert fehlende Scopes und zeigt ausgewählte sowie gewährte Scopes in den Verbindungsdetails. Auch ein Refresh darf Scopes reduzieren; fehlt die Scope-Angabe, bleibt der bisher gewährte Umfang erhalten. Nicht angeforderte Scopes sowie ein Konto- oder Site-Wechsel beim Refresh werden weiterhin abgelehnt. Tools mit fehlenden Berechtigungen können nicht verfügbar sein oder von Atlassian abgelehnt werden.

Der Token ist an eine Site gebunden und repräsentiert ein Atlassian-Systemkonto, nicht zwingend die angemeldete Person. Verbindungsdetails zeigen die Cloud-ID. Access-Tokens laufen derzeit nach acht Stunden ab; die verschlüsselte Verbindung übernimmt den Refresh. Refresh-Tokens gelten ungefähr 90 Tage, abhängig von Atlassians Regeln und Widerruf.

Fehlgeschlagene oder unterbrochene Registrierungen werden nicht automatisch wiederholt. Ein Administrator muss den Zustand prüfen und gegebenenfalls Connector samt abhängiger Konfiguration bewusst entfernen und neu erstellen. Dasselbe gilt bei geändertem Callback-Ursprung. Beim Trennen kann ein zusätzlicher Widerruf in Atlassians Einstellungen erforderlich sein.

## Geteilte Service-Account-Verbindungen

Unter **Admin → Connections → Add shared connection** wählst du einen aktivierten
Atlassian-MCP-Connector, eine unveränderliche eindeutige Verbindungskennung, einen Anzeigenamen,
den geheimen API-Token und mindestens einen vorhandenen Weldall-Nutzungsscope.
Die Kennung ist ein öffentlicher Name zur Auswahl der Verbindung in Apps und SDKs, **nicht der Token**.
Der geheime API-Token ist nur schreibbar und wird per Envelope-Verschlüsselung gespeichert.

Unterstützt werden ausschließlich **Atlassian-Service-Account-API-Keys mit Bearer**,
keine persönlichen Basic-API-Tokens oder geteilten OAuth-Grants. Die Atlassian-Organisation muss
API-Token-Authentifizierung erlauben; Weldall verlangt dafür keine Bestätigungs-Checkbox.
Token-Berechtigungen werden in Atlassian verwaltet, nicht zusätzlich in Weldall konfiguriert
oder von Weldall überprüft. Weldall-Nutzungsscopes steuern, wer die Verbindung verwenden darf,
nicht die Atlassian-Berechtigungen des Tokens. Optionale Cloud-IDs sind Anzeigemetadaten und
werden nicht in Argumente eingefügt. Manche Tools benötigen OAuth, andere explizite `cloudId`-Argumente.

Alle Connector-Scopes **und** alle Nutzungsscopes müssen erfüllt sein; auch Administratoren
und Credential-Manager erhalten keinen Bypass. Persönliches OAuth bleibt eigentümergebunden.
Die Übersicht filtert Personal/Shared; die Detailansicht bietet versionsgeprüfte
Scope-Änderung, Key-Rotation, Deaktivierung und Löschung. Zugriffstyp und Schlüssel bleiben
unveränderlich. Deaktivieren setzt den Status auf **Disabled** und sperrt alle Aufrufe;
der Token bleibt verschlüsselt gespeichert. **Enable connection** aktiviert den lokalen Zugriff
wieder. Token-Rotation aktiviert eine deaktivierte Verbindung nicht automatisch.
**Reconnect required** bleibt ein separater Fehlerzustand und lässt sich nicht über diesen
Schalter aufheben. Keys separat in Atlassian
widerrufen: lokale Löschung oder Deaktivierung ist kein Upstream-Widerruf.

IaC verwaltet Scopes und Zuweisungen, **keine Secrets oder Shared-Connection-Platzhalter**.
Referenzierte Scopes können nicht gelöscht werden. Zuerst die Verbindung in der UI löschen
oder ihre Scopes ersetzen, dann den Scope in einem separaten IaC-Apply entfernen.

Maschinen verwenden TypeScript/Python-SDKs mit `weldall:mcp`, allen Connector-/Nutzungsscopes
und einem DPoP-Token für Weldalls eigene Resource. Es gibt keinen CLI-Maschinenmodus.
`createWeldallMcpClient` bzw. `create_weldall_mcp_client` unterstützt Discovery, Tools,
Ressourcen, Aufrufe und Lesezugriffe anhand des stabilen Verbindungsschlüssels.
Python-MCP-Methoden sind asynchron und werden mit `await` aufgerufen. Das Gesamtzeitlimit
umfasst Verbindungsaufbau, Header und Antwortinhalt.
Jede Anfrage erhält einen neuen Proof; aktuelle Maschinenzuweisungen begrenzen die
Token-Scopes. Kein Aufruf wird automatisch wiederholt. Beispiele:
[englische MCP-Referenz](../../mcp/) und [SDKs](../sdks/).

## CLI

```sh
weldall connections connect atlassian-mcp --name my-atlassian-mcp
weldall mcp list --json
weldall mcp tools atlassian-mcp --connection my-atlassian-mcp --json
weldall mcp resources atlassian-mcp --connection my-atlassian-mcp --json
weldall mcp call atlassian-mcp TOOL_NAME --connection my-atlassian-mcp --arguments '{}' --json
weldall mcp read-resource atlassian-mcp --connection my-atlassian-mcp --uri 'RESOURCE_URI' --json
```

Tool-Namen, Argumente und Ressourcen-URIs müssen aus der tatsächlichen Discovery stammen. JSON-Ausgaben erhalten strukturierte Ergebnisse, fachliche Fehler sowie Text-/Blob-Inhalte. Fehlgeschlagene Aufrufe niemals automatisch wiederholen: Die Aktion könnte bereits ausgeführt worden sein.

## Goose und Skills

Connector- und Verbindungsmetadaten enthalten `capabilities: ["mcp"]`. Goose prüft dieses Feld statt Provider-Namen. `weldall mcp list --json` liefert den nach Fähigkeiten gefilterten Connector-Katalog; konkrete Tools werden weiterhin für das ausgewählte Konto live ermittelt.

SDK-Kataloge dürfen Scopes und Connectoren referenzieren, bevor diese existieren; die Referenzen werden gespeichert, ohne etwas automatisch anzulegen. Skills mit MCP-Abhängigkeiten erscheinen im Nutzerkatalog und sind direkt abrufbar, wenn alle referenzierten Connectoren existieren, aktiviert und MCP-fähig sind und der Nutzer die erforderlichen Connector-Scopes besitzt. Das gilt für manuelle und von Ressourcen veröffentlichte Skills unabhängig von ihrer Sichtbarkeitseinstellung. Eine fehlende persönliche Verbindung blendet den Skill nicht aus. Veröffentlichte Skills mit unbekannten erforderlichen Scopes bleiben bis zur Registrierung dieser Scopes verborgen.

`mcpDependencies` eines Skills enthält `connectorKey` (zum Beispiel `atlassian-mcp`), die exakten `tools` und `includeResources`. Beim Laden aktiviert Goose nur diese Tools. Genau eine passende READY-Verbindung wird automatisch verwendet; persönliche und zugängliche geteilte Verbindungen zählen gemeinsam. Bei mehreren Konten fragt der Agent und verwendet anschließend `select_mcp_connection`. Ohne Konto wird der fehlende Verbindungsaufbau gemeldet. Die Auswahl kann die im Skill festgelegten Tools nicht ersetzen. Erreicht der bestehende Verbindungskatalog sein Limit von 200 Einträgen, wird keine Eindeutigkeit angenommen; dann ist eine explizite Auswahl aus den sichtbaren Konten nötig.

Aktivierung ist sitzungslokal und kumulativ. Ein Connector bleibt an dasselbe Konto gebunden. Tool-Namen verwenden `mcp_<Hash des Connector-Schlüssels>__upstreamName`; verwende die von der Erweiterung angebotenen Namen. Ressourcen verwenden `weldall-mcp://` und können nur über bekannte Sitzungseinträge gelesen werden. Änderungen melden sich über MCP-List-Changed-Notifications. Die sechs bisherigen Tools bleiben erhalten.

Skill-Abhängigkeiten sind **keine Berechtigungen oder Tool-Allowlist**. Jeder Aufruf prüft serverseitig Eigentümer- oder Scope-Autorisierung, Connector-Zugriff, Zustand, Grants, Quota und aktuelle Konfiguration.

## Grenzen und Einführung

Vor dem aktualisierten Server müssen die Migrationen bis einschließlich `0020_connection_disabled_status` eingespielt werden. Die bereits angewendete Migration `0018_mcp` bleibt unverändert; bestehende Konfiguration wird nicht zurückgesetzt. Für MCP-Workflows CLI und Goose-Erweiterung gemeinsam aktualisieren. Pro Skill sind acht Connector-Abhängigkeiten und 32 Tool-Namen je Connector erlaubt; Discovery ist auf 100 Tools/Ressourcen, 20 Seiten und 1 MiB begrenzt, Ergebnisse auf 10 MiB. Goose begrenzt CLI-Argumente zusätzlich auf 24.000 Zeichen.

HTTPS, geprüfte Provider-Endpunkte und öffentliche IPv4-Ziele sind verpflichtend. DNS-Pinning und TLS-Hostname-Prüfung verhindern Zielwechsel. Redirects und automatische Wiederholungen sind deaktiviert. Audits enthalten Metadaten, keine Argumente, Ergebnisse oder Zugangsdaten.

Nicht enthalten: öffentlicher MCP-Endpunkt, Prompts, Resource Templates/Subscriptions, MCP Apps oder Tool-spezifische Autorisierungsregeln. Automatische Fixture-/Pakettests ersetzen nicht die abschließende Atlassian- und Stock-Goose-Abnahme in deiner Umgebung.
