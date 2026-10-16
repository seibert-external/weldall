---
title: MCP
description: Referenz für Konfiguration und Nutzung von Remote-MCP-Verbindungen.
---

Weldall vermittelt MCP-Tools und Ressourcen über Streamable HTTP. Clients verwenden die private DPoP-geschützte JSON-API; Provider-Zugangsdaten bleiben verschlüsselt auf dem Server. Dies ist kein öffentlicher MCP-Endpunkt.

## Einrichtung

Lege unter **Admin → Connectors** einen **Atlassian MCP**-Connector an oder verwende das [IaC-Beispiel](../../mcp/#configure-a-connector). Es gibt keine separate MCP-Server-Konfiguration. Der Endpunkt ist fest `https://mcp.atlassian.com/v2/mcp`; OAuth-Client-ID und Anwendungssecret werden nicht eingegeben. `LOCAL_ENV` oder `OPENBAO` wird beim Anlegen festgelegt und ist unveränderlich; bei OpenBao-Fehlern gibt es keinen lokalen Fallback. Bestehende Atlassian-REST-Verbindungen sind getrennt und werden nicht wiederverwendet. IaC-Apply startet keine Registrierung oder Zustimmung. Vor Deaktivierung/Löschung eines Connectors dessen Skill-Abhängigkeiten entfernen.

```sh
weldall connections connect atlassian-mcp --name my-atlassian-mcp
weldall connections show my-atlassian-mcp
```

Die erste Verbindung registriert einen öffentlichen OAuth-Client mit PKCE S256 und `token_endpoint_auth_method: none`. Callback: `https://weldall.example.com/api/connectors/atlassian-mcp/callback` mit deiner Weldall-Domain. Zu den MCP-Berechtigungen kommen `read:me`, `read:account` und `offline_access`.

Tokens sind an eine Site gebunden und repräsentieren ein Atlassian-Systemkonto, nicht zwingend die angemeldete Person. Verbindungsdetails zeigen Cloud-ID sowie ausgewählte/gewährte Scopes. Reduzierte Grants werden akzeptiert; fehlende Berechtigungen können Tools unbenutzbar machen. Refresh verwendet die vom Provider gemeldete Laufzeit und erhält bisherige Scopes, wenn sie in der Antwort fehlen. Nicht angeforderte Scopes oder Konto-/Site-Wechsel werden abgelehnt. Bei Bedarf erneut verbinden.

Registrierung ist zwischen Workern koordiniert; parallele Anfragen können einen laufenden Vorgang melden. Fehlgeschlagene/unterbrochene Registrierungen werden nicht automatisch wiederholt. Vor bewusstem Neuanlegen des Connectors samt abhängiger Konfiguration den Fehler prüfen; ein geänderter Callback-Ursprung benötigt ebenfalls diese Wiederherstellung. Lokales Trennen ersetzt nicht den Widerruf in Atlassians Connected-App-Einstellungen.

## Geteilte Service-Account-Verbindungen

Unter **Admin → Connections → Add shared connection** einen Atlassian-MCP-Connector, eine global eindeutige unveränderliche Kennung, einen Anzeigenamen und mindestens einen vorhandenen Nicht-System-Nutzungsscope wählen. Die Kennung wählt die Verbindung aus; sie ist **nicht der Token**. Unterstützt werden **Atlassian-Service-Account-API-Keys mit Bearer**, keine persönlichen Basic-Tokens oder geteilten OAuth-Grants. Die Organisation muss API-Token-Authentifizierung erlauben.

- Alle Connector-Scopes **und** alle Nutzungsscopes sind erforderlich, auch für Administratoren und Credential-Manager. Persönliches OAuth bleibt eigentümergebunden. Zugriffstyp und Kennung sind unveränderlich; Anzeigenamen dürfen mehrfach vorkommen.
- Token-Berechtigungen verwaltet Atlassian; Weldall prüft sie nicht. Optionale Cloud-IDs sind Metadaten und werden nicht in Argumente eingefügt. Manche Tools benötigen OAuth, API-Key-Aufrufe gegebenenfalls ein explizites `cloudId`-Argument.
- Deaktivierte Entwürfe benötigen kein Credential. Provisionierung/Rotation aktiviert sie nicht. Für Aufrufe müssen Connector und Verbindung aktiv sein; Deaktivieren erhält den Token. Die Detailansicht erlaubt versionsgeprüfte Scope-Änderung, Rotation und Löschung. **Reconnect required** ist ein Credential-Fehler, den der Aktivierungsschalter nicht behebt. Vor Ablauf rotieren; Keys separat in Atlassian widerrufen.
- [IaC](../infrastructure-as-code/#öffentliche-konfiguration-secrets-nur-in-der-ui) verwaltet öffentliche Konfiguration und Import, niemals Secrets. Scope-Ersetzungen sind zusammen mit verwalteten Verbindungen atomar möglich; Referenzen außerhalb des Workspaces blockieren Löschung. Die Scopeliste darf nicht leer sein. Löschung entfernt die eigenen Scope-Zuordnungen und das verschlüsselte Credential, keinen Upstream-Zugriff.

Maschinen verwenden `createWeldallMcpClient` (TypeScript) oder `create_weldall_mcp_client` (Python) mit `weldall:mcp`, allen Connector-/Nutzungsscopes und einem DPoP-Token für Weldalls eigene Resource (`https://weldall.example.com/api`). Kein CLI-Maschinenmodus, Maschinen-OAuth oder Secret-Provisionierung über die Laufzeit-API. Beispiele und sprachspezifische Details: [TypeScript](https://github.com/seibert-external/weldall/blob/main/packages/sdk/README.md#call-shared-mcp-connections-as-a-machine), [Python](https://github.com/seibert-external/weldall/blob/main/packages/python-sdk/README.md#call-shared-mcp-connections-as-a-machine).

Discovery liefert nur zugängliche geteilte Verbindungen. Jede Anfrage erhält einen frischen Proof; aktuelle Zuweisungen begrenzen Token-Scopes. Scope-/Schlüsselwiderruf und Maschinendeaktivierung sperren folgende Aufrufe. SDK-Anfragen sind begrenzt und werden nicht wiederholt. Python-MCP-Methoden benötigen `await`.

## CLI

```sh
weldall mcp list --json
weldall mcp tools atlassian-mcp --connection my-atlassian-mcp --json
weldall mcp resources atlassian-mcp --connection my-atlassian-mcp --json
weldall mcp call atlassian-mcp TOOL_NAME --connection my-atlassian-mcp --arguments '{}' --json
weldall mcp read-resource atlassian-mcp --connection my-atlassian-mcp --uri 'RESOURCE_URI' --json
```

Tool-Namen, Argumente und Ressourcen-URIs aus der tatsächlichen Discovery verwenden. JSON erhält unterstützte Content-Blöcke, strukturierte Ergebnisse, fachliche Fehler und Text-/Blob-Ressourcen, nicht beliebige Upstream-Erweiterungen oder MCP-Apps-Metadaten. Jeder Aufruf prüft Autorisierung, Bereitschaft, Grants, Quota und Konfiguration erneut. Fehlgeschlagene Aufrufe niemals automatisch wiederholen: Die Aktion könnte bereits ausgeführt sein.

## Skills und Agent-Hosts

IaC-Skills und SDK-Kataloge können `mcpDependencies` mit `connectorKey`, exakten `tools` und `includeResources` deklarieren; siehe [Beispiel](../../mcp/#skills-and-agent-hosts). Das ist Kontextauswahl, **keine Berechtigung oder Tool-Allowlist**. SDK-Kataloge dürfen noch nicht vorhandene Connectoren/Scopes referenzieren, ohne sie anzulegen. MCP-abhängige Skills sind nur sichtbar/abrufbar, wenn alle Connectoren existieren, aktiviert und MCP-fähig sind und der Aufrufer deren Scopes besitzt. Eine fehlende persönliche Verbindung blendet den Skill nicht aus, unbekannte erforderliche Scopes dagegen schon. Dies gilt auch für veröffentlichte Skills unabhängig von der Sichtbarkeitseinstellung.

Hosts mit Weldalls lokaler MCP-Erweiterung müssen List-Changed-Notifications unterstützen. `read_skill_document` aktiviert nur deklarierte Tools/Ressourcen; Connector und Verbindung müssen ausdrücklich `capabilities: ["mcp"]` melden. Eine passende READY-Verbindung wird automatisch gewählt, bei mehreren Konten fragt der Agent und verwendet `select_mcp_connection` mit einer angebotenen ID. Fehlende Konten benötigen Einrichtung; mehrdeutige Namen werden abgewiesen. Beim Kataloglimit von 200 Verbindungen ist die Auswahl explizit. Weder Toolliste noch sitzungsgebundenes Konto sind dadurch austauschbar; für einen Kontowechsel eine neue Sitzung beginnen.

Aktivierung ist kumulativ; vorhandene Tools bleiben erhalten. Angebotene `mcp_<Connector-Key-Hash>__upstreamName`-Namen und sitzungslokale `weldall-mcp://`-URIs verwenden, keine URLs konstruieren. Nur angebotene URIs können gelesen werden. Jeder Aufruf geht über die lokale CLI und wird serverseitig erneut autorisiert.

## Grenzen und Einführung

- [Rollout-Reihenfolge](../infrastructure-as-code/#rollout-und-kompatibilität) einschließlich `0021_iac_secret_primitives` beachten; lokale MCP-Erweiterung mit Server/CLI aktualisieren. Ältere HTTP-Workflows bleiben unterstützt. Live-Atlassian-Autorisierung und Host-Verhalten in der eigenen Umgebung prüfen; Fixture-Tests belegen diese Kompatibilität nicht.
- Pro Skill höchstens 8 Connectoren und 32 Tools je Connector. Discovery: 100 Tools/Ressourcen, 20 Seiten, 1 MiB Definitionen. Ergebnisse: 10 MiB. Die lokale Erweiterung begrenzt CLI-Argumente auf 24.000 Zeichen.
- Nur geprüfte kanonische HTTPS-Endpunkte mit öffentlichen IPv4-Zielen. DNS-Pinning und TLS-Hostname-Prüfung sind aktiv; Redirects, private Ziele, Proxy-Weiterleitung, automatische Aufrufwiederherstellung und Session-Resumption sind deaktiviert.
- Audits enthalten Kennungen, Ergebnisse im Sinne von Erfolg/Fehler, Laufzeiten und Ressourcen-Fingerprints, keine Argumente, Inhalte oder Credentials.
- Nicht enthalten: öffentlicher MCP-Endpunkt, Prompts, Resource Templates/Subscriptions, MCP Apps oder Tool-spezifische Autorisierungsregeln.
