# Weldall Connectors

## Status

Planung für einen generischen Weldall-Mechanismus zur Anbindung externer Dienste.

## Ziel

Weldall soll externe Dienste wie Google, Atlassian oder HubSpot einheitlich anbinden können.

Dabei sollen:

- Nutzer ihre Accounts einfach per OAuth verbinden können,
- Administratoren zentral sehen können, wer welche Accounts verbunden hat,
- verfügbare Connectoren und ihre Berechtigungen zentral steuerbar sein,
- Provider-Credentials nicht in der zentralen Weldall-Datenbank liegen falls das nicht notwendig ist (lokale Accounts),
- mehrere konfigurierte Instanzen eines Connector-Typs möglich sind,
- Connector-Implementierungen zunächst direkt im Weldall-Backend laufen und später bei Bedarf externe Dienste angebunden werden können,
- Requests dieselben URL- und Ausgabe-Konventionen verwenden, ohne persönliche und geteilte Accounts in ein gemeinsames Lifecycle-Modell zu zwingen,
- später auch gemeinsam verwendete Accounts und Service Accounts möglich sein.

Weldall trennt dafür die wiederverwendbare Provider-Konfiguration (`Connector`) von zwei eigenständigen Primitiven: `PersonalConnection` in V1 und später `SharedConnection`. Gemeinsam sind Provider-Operationen und Zielregeln, nicht Credential-Speicherung, Berechtigungen oder Lifecycle.

## Planungsdokumente

- [V1-Checkliste](v1-checklist.md)
- [CLI-Interface](interfaces/cli.md)
- [Connector-Interface](interfaces/connector.md)

## Admin-UI

Die Connector-Verwaltung folgt den bestehenden Admin-Patterns in `apps/weldall`:

- tRPC `queryOptions` und `mutationOptions` werden mit TanStack Query verwendet,
- Formulare verwenden TanStack Form und die vorhandenen ASTRYX-Formkomponenten,
- eine installationsweite Connection-Liste zeigt Administratoren alle Connections,
- Connector- und Connection-Listen verwenden TanStack Table,
- Filter, Sortierung und Pagination werden bei Bedarf mit `nuqs` in der URL gehalten,
- erfolgreiche Mutationen aktualisieren die betroffenen Queries und zeigen den vorhandenen Operation-Toast,
- Änderungen und Löschungen verwenden Versionsfelder und die bestehenden Bestätigungsdialoge.

Es wird keine zweite Datenzugriffs- oder Formularabstraktion für Connectoren eingeführt.

## Grundmodell

```text
                       Weldall Backend
             Connector Registry, Connections,
                 Policies, ACLs und UI
                              │
                 Connector-Implementierungen
                              │
                              ▼
                         Google (V1)
```

Ein **Connector-Typ** ist die mit Weldall ausgelieferte Provider-Implementierung und definiert unter anderem Konfigurationsschema, erlaubte Ziel-URLs und Provider-Operationen für Autorisierung, Refresh und Widerruf.

Ein **Connector** ist eine durch einen Administrator konfigurierte Instanz eines Connector-Typs. Von einem Typ können mehrere Connectoren existieren.

Eine **PersonalConnection** beschreibt einen konkreten Provider-Account, beispielsweise `julian@example.com`, mit genau einem Besitzer und einem verbundenen Gerät. Ihre Credentials liegen lokal; Requests laufen direkt von der CLI zum Provider. Sie ist nicht teilbar.

Eine spätere **SharedConnection** ist ein eigenständiges Modell mit serverseitigen Credentials, eigenen Zugriffsrechten und eigener Verwaltung. Sie referenziert ebenfalls einen Connector, ist aber weder ein Credential-Modus noch eine Unterklasse der PersonalConnection.

```text
Connector (konfigurierte Provider-Integration)
├── PersonalConnection → Nutzer/Gerät → lokale Keychain → direkter Request
└── SharedConnection   → Zugriffsrechte → Server-Credentials → Backend-Request (später)
```

Ein **Credential** ist das Provider-Geheimnis. `OAuthCredentials` beschreibt das Access-/Refresh-Token-Format unabhängig vom Speicherort; die Google-Implementierung kann daher später von beiden Primitiven verwendet werden. V1 implementiert ausschließlich den persönlichen Lifecycle.

## Zentrale Connection-Übersicht

Das zentrale PersonalConnection-Objekt enthält ausschließlich Metadaten:

- Connector und Provider,
- Besitzer der Connection,
- frei wählbarer Connection-Name,
- Anzeigename oder E-Mail des verbundenen Accounts,
- stabile Provider-Account-ID,
- gewährte Provider-Berechtigungen,
- das verbundene Gerät (verpflichtend bei PersonalConnection),
- Status,
- Zeitpunkt der Verbindung und letzten Nutzung.

Der OAuth-Broker oder Connector bestätigt nach erfolgreichem Verbindungsablauf die Account-Identität und aktiviert die Connection. Die CLI kann diese Identität nicht selbst festlegen.

Die zentrale Admin-UI zeigt installationsweit alle PersonalConnections mit Besitzer, Google-Account, Connector, Scopes, Gerät, Status sowie dem Zeitpunkt der Verbindung und der letzten Lease. Administratoren können eine PersonalConnection trennen: Weldall löscht den Datensatz und beendet die weitere Lease-Ausstellung unabhängig davon, ob eine CLI noch erreichbar ist. Lokale Credentials sind dort niemals sichtbar. Der unveränderte Handoff prüft den authentifizierten Besitzer und die übermittelte Gerätekennung; diese Kennung wird nicht aus dem DPoP-Proof abgeleitet.

## Audit-Log

Änderungen an Connectoren, der Connection-Lebenszyklus, Credential-Refreshes und die Ausstellung oder Ablehnung von Connection Leases werden im bestehenden Weldall-Audit-Log erfasst. Secrets, OAuth-Codes, Header, Bodies und URL-Query-Parameter dürfen nicht in Audit-Metadaten gelangen. Die vorgesehenen Event-Typen stehen im [Connector-Interface](interfaces/connector.md#audit-log).

## Getrennte Connection-Primitiven

### PersonalConnection: lokal auf dem Gerät

Die Zugangsdaten liegen in der Betriebssystem-Keychain des Nutzers. Bei Google sind das zunächst Access- und Refresh-Token. PersonalConnection hat kein `credentialMode`-Feld: Die lokale Speicherung ist Teil ihrer Definition, nicht eine umschaltbare Transportoption.

```text
Weldall CLI → Provider API
```

Die CLI ruft den Provider direkt auf. Ein zentraler OAuth-Broker kann den Code-Exchange und spätere Refreshes durchführen, wenn der Provider dafür ein vertrauliches Client Secret verlangt. Der Broker sieht die Tokens dabei kurzfristig, speichert sie aber nicht dauerhaft.

Vorteile:

- keine zentrale Token-Datenbank,
- direkte Requests ohne Connector-Proxy,
- für viele persönliche OAuth-Verbindungen geeignet,
- begrenzter Schaden bei einem kompromittierten Connector.

Einschränkungen:

- nur auf dem jeweiligen Gerät nutzbar,
- nicht für Background-Jobs geeignet,
- kein vollständiges serverseitiges API-Audit,
- bereits ausgegebene Tokens können außerhalb der Weldall CLI verwendet werden.

Die CLI darf Tokens nur an die beim Connector registrierten Provider-Ziele senden. Redirects und nicht registrierte Ziel-URLs sind nicht erlaubt.

### Spätere Erweiterung: SharedConnection

SharedConnection ist nicht Teil von V1. Sie erhält ein eigenes Datenmodell, eigene Verträge und einen eigenen Lifecycle. Weldall könnte ihr Credential verschlüsselt speichern und Requests im Namen berechtigter Akteure an die Provider-API senden.

```text
Weldall CLI → Weldall Backend → Provider API
```

Dieses eigenständige Primitive eignet sich für:

- zentral verwaltete Accounts,
- Service Accounts,
- Background-Jobs,
- zentrale Request-Policies,
- vollständigeres Audit,
- künftig auch geteilte Connections.

Für eine solche Erweiterung können verwaltete Credentials verschlüsselt in PostgreSQL gespeichert werden. Eine Connector-Implementierung dürfte nur Zugriff auf das Credential der Connection erhalten, für die sie aufgerufen wurde.

## Einheitliches Request-Modell

Die URL beschreibt immer das logische Request-Ziel. In V1 wählt `--connection` eine PersonalConnection. Eine spätere SharedConnection darf dieselben URL- und Ausgabe-Konventionen verwenden, benötigt aber einen eigenen Ausführungspfad.

```text
absolute URL       = wohin?
personal connection = als welcher persönliche Account? (V1, direkt)
shared connection   = als welcher freigegebene Account? (später, Backend)
```

Die bestehenden CLI-Befehle `connections` und `request --connection` bleiben die persönliche Oberfläche. Die spätere SharedConnection-Syntax wird separat festgelegt; eine einheitliche Benutzerführung erzwingt keine gemeinsamen Domain-Objekte. Details stehen im [CLI-Interface](interfaces/cli.md).

Vor jeder Verwendung prüft Weldall, ob der Akteur die Connection verwenden darf und ob sie aktiv ist. Das ausgewählte Connection-Objekt wird über eine stabile ID an die Autorisierung gebunden; frei gesetzte Request-Header dürfen keine andere Connection auswählen können.

## Zentrale Kontrolle bei lokalen Credentials

Vor der Verwendung einer lokalen Connection bezieht die CLI eine kurzlebige, signierte Connection Lease von Weldall.

```text
CLI → Weldall: Connection und Ziel verwenden
CLI ← Weldall: signierte, kurzlebige Lease
CLI → Provider: direkter Request
```

Die Lease kann für kurze Zeit gecacht werden. Dadurch kann Weldall:

- gelöschte PersonalConnections oder deaktivierte Connectoren unabhängig von lokaler Credential-Bereinigung blockieren,
- den Akteur und die Connection autorisieren,
- das Ziel gegen die registrierten URL-Präfixe prüfen,
- die Nutzung einer Connection erfassen,

ohne den Provider-Request zu proxien.

Diese Kontrolle gilt für die offizielle Weldall CLI. Sie kann nicht verhindern, dass ein lokal extrahiertes Bearer Token direkt verwendet wird.

## Einheitliches Connector-Interface

In V1 läuft ausschließlich die Google-Implementierung direkt im Weldall-Backend. Die gemeinsame interne Schnittstelle vereinheitlicht:

- typspezifische Konfiguration und Validierung,
- OAuth- oder andere Verbindungsabläufe,
- Reconnect und Disconnect,
- Bestätigung von Provider-Account und gewährten Berechtigungen,
- Credential-Refresh,
- Provider-Operationen und Zielregeln, die persönliche und später geteilte Connections wiederverwenden können. Die direkte CLI-Ausführung und die spätere serverseitige Ausführung gehören dagegen zu ihren getrennten Primitiven.

Administratoren erstellen konfigurierte Connectoren über die Admin-UI und die zugehörige serverseitige API. OAuth-Client-Secrets können gesetzt oder ersetzt, aber nicht ausgelesen werden. Weldall speichert sie verschlüsselt in PostgreSQL. Connectoren sind zunächst nicht IaC-fähig. Connections verweisen auf die stabile ID des konfigurierten Connectors.

Ein separates HTTP-Protokoll zwischen Weldall und Connectoren ist nicht Teil der ersten Implementierung. Falls später externe Connector-Dienste benötigt werden, kann eine weitere Implementierung dieselben Operationen an einen solchen Dienst weiterleiten. Das dafür notwendige Netzwerkprotokoll wird erst dann festgelegt. Details stehen im [Connector-Interface](interfaces/connector.md).

## Sharing und Service Accounts

Sharing und Service Accounts sollen künftig möglich sein, sind aber ausdrücklich **nicht Teil der ersten Implementierung**.

Spätere SharedConnections können eigenständige Berechtigungen erhalten:

- `use`: Connection verwenden,
- `manage`: Verbindung verwalten oder erneuern,
- `share`: weiteren Nutzern oder Gruppen Zugriff geben.

Berechtigungen können dann Nutzern, Gruppen oder Service Principals erteilt werden. Geteilt wird die Verwendung einer SharedConnection, niemals das Credential selbst. PersonalConnections bleiben persönlich und nicht teilbar; sie werden nicht durch einen Moduswechsel zu SharedConnections. Gemeinsame Connector-Konfiguration und Provider-Code werden wiederverwendet, nicht die persönliche Credential-Übergabe oder Besitzer-/Gerätelogik.

Bei jeder Verwendung müssen weiterhin zwei Identitäten sichtbar bleiben:

- der Akteur, der die Aktion ausgelöst hat,
- der Upstream-Account, über den sie ausgeführt wurde.

Für die erste Implementierung werden ausschließlich persönliche Connections modelliert und in der CLI angeboten. Es gibt zunächst keine Sharing-Befehle.

## Mögliche Ausbaustufe: Delegated DPoP

Unterstützt ein Provider DPoP-gebundene Refresh Tokens, kann später ein gesonderter persönlicher Credential-Mechanismus entworfen werden:

- Refresh Token liegt serverseitig,
- privater DPoP-Key liegt auf dem Nutzergerät,
- die CLI erstellt bei Bedarf einen generischen DPoP-Proof,
- ein Datenbank-Diebstahl liefert keinen allein verwendbaren Refresh Token.

Dieser Mechanismus wäre gerätegebunden und nicht für Sharing oder Background-Jobs geeignet. Er ist keine Voraussetzung für die erste Version und begründet kein generisches Credential-Modell in V1.

## Erste Implementierung

**V1 enthält ausschließlich den Connector-Typ `google`.** Er unterstützt Gmail und Google Calendar. Connectoren für Atlassian Cloud, HubSpot oder andere Anbieter sind nicht Teil von V1.

1. Registry der lokal verfügbaren Connector-Typen.
2. Über die Admin-UI konfigurierbare Google-Connectoren mit typspezifischer Validierung und verschlüsselter Speicherung der OAuth-Client-Secrets.
3. Gemeinsame interne Connector-Schnittstelle mit einer Google-Implementierung für Gmail und Google Calendar.
4. Eigenständige Modelle `PersonalConnection` und `PersonalConnectionAuthorization` mit verpflichtendem Besitzer und Gerät, ohne Credential-Modus.
5. Persönlicher Lifecycle mit Keychain, OAuth-Broker und kurzlebigen Leases.
6. Connection-Auswahl und direkte Request-Ausführung in der CLI.
7. Reconnect und Disconnect.
8. Admin-Oberflächen auf Basis der bestehenden TanStack-Query-, TanStack-Form- und TanStack-Table-Patterns.
9. Installationsweite Admin-Liste aller PersonalConnections mit serverseitigem Disconnect.
10. Audit-Events für Connectoren, Connections, Credential-Refreshes und Leases.

Nicht enthalten sind SharedConnection, Sharing, Service Accounts, Background-Jobs und Delegated DPoP. Es gibt weder Platzhaltertabellen noch ACL- oder Transport-Unionen für diese späteren Funktionen.
