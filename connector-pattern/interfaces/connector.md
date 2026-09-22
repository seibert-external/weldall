# Connector-Interface

## Ziel

V1 enthält ausschließlich den Connector-Typ `google` mit Gmail und Google Calendar sowie das Primitive `PersonalConnection`.

Eine PersonalConnection gehört genau einem Nutzer und Gerät. Ihre Zugangsdaten liegen dauerhaft nur in der Betriebssystem-Keychain des Nutzergeräts. Für Google sind das Access- und Refresh-Token (`OAuthCredentials`). Der Credential-Typ beschreibt das Provider-Format, nicht den Speicherort. Ein `credentialMode` ist weder Teil des Datenmodells noch der API.

Die Google-Anbindung läuft direkt im Weldall-Backend. Ein zusätzlicher Connector-Dienst und ein eigenes HTTP-Protokoll sind nicht erforderlich. Connectoren für Atlassian Cloud, HubSpot oder andere Anbieter sind ausdrücklich nicht Teil von V1.

E-Mails, Kalender und andere Google-Daten werden nicht in die Weldall-Datenbank kopiert. Die CLI greift mit `weldall request -c <connection> <url>` direkt auf die jeweilige Google API zu.

## Begriffe

### Connector-Typ

Ein Connector-Typ ist die in Weldall enthaltene Implementierung für einen Anbieter. In V1 ist nur der Typ `google` vorhanden.

Der Connector-Typ legt fest:

- welche Konfiguration erforderlich ist,
- wie der OAuth-Ablauf funktioniert,
- welche APIs, Ziele und OAuth-Scopes zulässig sind,
- wie Zugangsdaten erneuert und widerrufen werden.

### Connector

Ein Connector ist eine von einem Administrator eingerichtete Instanz eines Connector-Typs. Mehrere Connectoren desselben Typs sind möglich.

Beispiele für zwei getrennt konfigurierte Google-Connectoren:

- `google-workspace` für die Firmenkonten,
- `google-private` für private Google-Konten.

### PersonalConnection

Eine PersonalConnection steht für einen persönlichen Account beim Anbieter, der über einen bestimmten Connector verbunden wurde. Sie verweist auf dessen stabile ID, gehört genau einem Nutzer und besitzt eine verpflichtende Gerätekennung. Nur ihr Besitzer kann sie verwenden; Administratoren können sie serverseitig trennen.

`PersonalConnectionAuthorization` speichert ausschließlich den befristeten OAuth-Vorgang und die einmalige Credential-Übergabe. `personal-connection-service.ts` implementiert diesen persönlichen Lifecycle.

### SharedConnection (später)

Eine SharedConnection ist ein separates Primitive mit serverseitigen Credentials, Zugriffsrechten und Backend-Ausführung. Sie referenziert denselben Connector-Typ bzw. eine konfigurierte Connector-Instanz. Sie wird nicht als weiterer Modus einer PersonalConnection modelliert und teilt weder deren Datensatz noch deren Gerätebindung oder Credential-Handoff. Wiederverwendbar bleiben Provider-Operationen, Konfigurationsvalidierung und Zielregeln.

```text
Connector-Typ   Connector           PersonalConnection (V1)
Google       →  google-workspace →  julian@example.com
             →  google-private   →  private@example.com
```

## Ablauf in V1

Die Google-Implementierung ist ein normales TypeScript-Modul im Weldall-Backend. Sie unterstützt den OAuth-Ablauf und kennt die zulässigen Google APIs. Die eigentlichen Gmail- und Calendar-Requests laufen nicht durch das Backend.

```text
Account verbinden:

CLI ──► Weldall ──► Google OAuth
CLI ◄── einmalige Übergabe der Zugangsdaten
 │
 └── speichert sie in der lokalen Keychain

API-Request:

CLI ──► Weldall: kurzlebige Connection Lease
CLI ───────────────────────────────► Gmail oder Calendar API
```

CLI und Browser kommunizieren für den Verbindungsablauf ausschließlich mit Weldall. Die Google-Implementierung stellt keine eigenen Endpunkte bereit. OAuth-Callbacks gehen an Weldall und werden dort dem richtigen Connector und der richtigen Connection zugeordnet.

## Connectoren verwalten

Administratoren erstellen und bearbeiten Connectoren in der Weldall-Admin-UI. Die dazugehörige Admin-API prüft sowohl die allgemeinen Felder als auch die Google-spezifische Konfiguration.

Jeder Connector besitzt mindestens:

- eine stabile ID,
- einen eindeutigen Schlüssel,
- einen Anzeigenamen,
- den unveränderlichen Connector-Typ `google`,
- einen Aktivierungsstatus,
- die Google-spezifische Konfiguration.

Das OAuth-Client-Secret des Connectors kann gesetzt oder ersetzt, aber nie wieder ausgelesen werden. Weldall verschlüsselt es mit `WELDALL_CREDENTIAL_ENCRYPTION_KEY` und speichert nur den verschlüsselten Wert in PostgreSQL. Dieses Client-Secret gehört zur serverseitigen Google-OAuth-Konfiguration. Es ist nicht das Credential einer Connection.

Connectoren gehören zunächst nicht zum IaC-Manifest. Sie erscheinen weder in `weldall.yml` noch in `weldall.lock.yml`, `weldall plan` oder `weldall up`. Das entspricht der derzeitigen Behandlung von Group Providern. IaC für administrative Ressourcen mit Secrets kann später gemeinsam entworfen werden.

### Umsetzung der Admin-UI

Die Oberfläche orientiert sich an den vorhandenen Admin-Seiten und führt keine connector-spezifische State-Management-Schicht ein:

- TanStack Query lädt Connectoren und Connections über die bestehenden tRPC-`queryOptions`.
- Create, Update, Test und Delete verwenden tRPC-`mutationOptions` mit TanStack Query.
- Nach erfolgreichen Mutationen werden die betroffenen Queries invalidiert und die vorhandenen Operation-Toasts verwendet.
- TanStack Form verwaltet die Connector-Formulare einschließlich feldnaher Validierung und Pending-Zuständen.
- TanStack Table rendert Connector- und Connection-Listen mit den vorhandenen Tabellenkomponenten.
- `nuqs` hält Suche, Sortierung und Pagination in der URL, sobald eine Liste diese Funktionen benötigt.
- Änderungen senden die geladene `version` als `expectedVersion`, damit parallele Admin-Änderungen nicht überschrieben werden.
- Secrets bleiben write-only; leere Secret-Felder behalten bei Updates den vorhandenen Wert.

Komponenten für Tabellen, Formulare, Dialoge, Banner und Toasts werden aus den bereits verwendeten ASTRYX- und Admin-Komponenten zusammengesetzt.

### Liste aller Connections

Die Admin-UI enthält neben der Connector-Liste eine installationsweite Liste aller Connections. Die persönliche CLI-Liste bleibt davon getrennt und zeigt weiterhin nur die Connections des angemeldeten Nutzers.

Die Admin-Liste verwendet TanStack Table, lädt paginiert über TanStack Query und hält Filter, Sortierung und Seite mit `nuqs` in der URL. Sie zeigt mindestens:

- Connection-Name und stabile ID,
- Besitzer,
- Google-Account,
- konfigurierten Connector,
- aktivierte Google APIs und gewährte Scopes,
- verbundenes Gerät,
- Status,
- Zeitpunkt der Verbindung und der letzten Lease.

Administratoren können Details öffnen und eine PersonalConnection trennen. Disconnect löscht den serverseitigen Datensatz und verhindert weitere Leases oder Refreshes, auch wenn die CLI offline oder aufgegeben ist. Administratoren können weder lokale Credentials anzeigen noch herunterladen. „Zuletzt verwendet“ bedeutet nur, dass Weldall eine Lease ausgestellt hat; der direkte Google-Request ist serverseitig nicht sichtbar.

### Google APIs

Gmail und Google Calendar verwenden dieselbe Google-OAuth-Infrastruktur, aber unterschiedliche API-Endpunkte und OAuth-Scopes. Deshalb gibt es einen gemeinsamen Connector-Typ `google`. Administratoren wählen in seiner Konfiguration aus, welche der beiden APIs verwendet werden dürfen.

Für jede aktivierte API definiert die Google-Implementierung feste Zielregeln und die auswählbaren OAuth-Scopes. Eine Connection speichert als Metadaten, welche Scopes der Nutzer tatsächlich gewährt hat. Wird später eine weitere Google API aktiviert, behalten bestehende Connections ihre bisherigen Berechtigungen; für zusätzliche Scopes müssen sie erneut verbunden werden.

Der Google-OAuth-Client muss die ausgewählten APIs unterstützen. Insbesondere Gmail-Scopes können eine zusätzliche Prüfung durch Google erfordern.

## Interne Programmierschnittstelle

Jeder Connector-Typ stellt eine Implementierung derselben internen TypeScript-Schnittstelle bereit. Die folgende Skizze beschreibt die Zuständigkeiten; Namen und genaue Typen sind noch nicht festgelegt.

```ts
interface ConnectorImplementation<TConfig> {
  readonly definition: {
    type: string;
    configurationVersion: string;
  };

  validateConfig(value: unknown): Promise<TConfig>;

  startAuthorization(
    context: ConnectorContext<TConfig>,
    input: StartAuthorizationInput,
  ): Promise<AuthorizationStart>;

  completeAuthorization(
    context: ConnectorContext<TConfig>,
    input: CompleteAuthorizationInput,
  ): Promise<AuthorizationResult>;

  refreshCredentials(
    context: ConnectorContext<TConfig>,
    input: RefreshCredentialsInput,
  ): Promise<OAuthCredentials>;

  revokeCredentials(
    context: ConnectorContext<TConfig>,
    input: RevokeCredentialsInput,
  ): Promise<void>;
}
```

Das Interface enthält Provider-Operationen, aber keine Connection-Speicherung oder ACLs. `OAuthCredentials` und `AuthorizationResult` bleiben vom persönlichen oder später geteilten Lifecycle unabhängig.

Weldall stellt der Implementierung nur die benötigten Funktionen bereit:

- Zugriff auf das OAuth-Client-Secret des eingerichteten Connectors,
- einen eingeschränkten HTTP-Client für Google-OAuth- und Account-Endpunkte,
- Funktionen für Audit-Einträge und Statusänderungen,
- austauschbare Zeit- und Zufallsquellen für Tests.

Die Google-Implementierung speichert keine Credentials einer Connection. Wenn sie beim Code-Austausch, Refresh oder Widerruf Zugangsdaten erhält, verarbeitet sie diese nur für die Dauer des Vorgangs.

## OAuth-Ablauf

### Account verbinden

1. Ein Nutzer wählt einen aktiven Google-Connector.
2. Weldall prüft die Berechtigung und legt eine befristete PersonalConnectionAuthorization mit reservierter Connection-ID an; die PersonalConnection entsteht erst nach erfolgreichem Callback.
3. Weldall erzeugt einen kurzlebigen OAuth-State. Dieser bindet Nutzer, Connector und Connection an den Vorgang.
4. Die Google-Implementierung erzeugt die Autorisierungs-URL mit den konfigurierten Scopes.
5. Nach der Zustimmung leitet Google den Browser zum Weldall-Callback zurück.
6. Die Google-Implementierung tauscht den Autorisierungscode gegen Zugangsdaten und ermittelt den verbundenen Google-Account.
7. Die CLI erhält die Zugangsdaten über eine kurzlebige, einmalig verwendbare Übergabe und speichert sie in `personalConnectionKeychain`. Die Übergabe prüft den authentifizierten Besitzer und die im Request übermittelte Gerätekennung. Eine zusätzliche Bindung dieser Kennung an den verifizierten DPoP-Thumbprint ist nicht Bestandteil dieses Refactorings.
8. Weldall speichert ausschließlich die bestätigte Account-ID, den Anzeigenamen, die gewährten Scopes und weitere Connection-Metadaten.
9. Weldall setzt die Connection auf `ready`.

Falls für die Übergabe kurzzeitig serverseitiger Zustand erforderlich ist, muss er verschlüsselt, eng befristet und nach dem ersten Abruf gelöscht werden. Er ist kein dauerhafter Credential-Speicher.

Die CLI kann Account-ID, Anzeigename und gewährte Scopes nicht selbst vorgeben.

### Zugangsdaten erneuern

Die CLI lädt das lokale Credential aus der Keychain. Wenn Google für die Erneuerung das vertrauliche OAuth-Client-Secret verlangt, sendet die CLI das Refresh Token an Weldall. Die Google-Implementierung führt den Refresh aus und gibt die neuen Zugangsdaten zurück, ohne sie dauerhaft zu speichern.

### Erneut verbinden

Beim erneuten Verbinden bleiben ID, Name und Besitzer der Connection erhalten. Die CLI ersetzt die bisherigen Zugangsdaten in der Keychain erst, nachdem der neue OAuth-Ablauf erfolgreich abgeschlossen wurde.

### Verbindung trennen

Weldall löscht die PersonalConnection und ihre Authorization-Vorgänge unabhängig davon, ob Google das Credential erfolgreich widerrufen kann. Liefert die CLI ein lokales Token mit, versucht der Broker danach dessen Widerruf bei Google. Die CLI löscht anschließend ihren Keychain-Eintrag. Server-Disconnect hängt nicht davon ab, ob diese lokale Bereinigung stattfindet; ein extrahiertes Provider-Token bleibt ohne Google-Widerruf bis zum Ablauf verwendbar.

## Requests über eine Connection

Connectoren bieten keine eigenen Befehle für E-Mails, Kalender oder andere Objekte an. Nutzer rufen die freigegebenen Google APIs direkt auf:

```sh
weldall request -c google-workspace \
  https://gmail.googleapis.com/gmail/v1/users/me/messages
```

Vor dem Request fordert die CLI eine kurzlebige, signierte Connection Lease von Weldall an. Weldall prüft dabei:

- Gehört die Connection dem aufrufenden Nutzer?
- Sind Connector und Connection aktiv?
- Gehört die URL zu den für den Connector und die Connection erlaubten Zielen?

Danach lädt die CLI das Credential aus der Keychain, erneuert es bei Bedarf und fügt es zum ausgehenden Request hinzu. Die Antwort von Google wird ohne zusätzliche Weldall-Datenhülle zurückgegeben.

Bei Google hängen die erlaubten Hosts, Pfade und Scopes von den aktivierten APIs `gmail` und `calendar` ab.

## Sicherheitsregeln für direkte Requests

Die CLI setzt mindestens folgende Regeln durch:

- ausschließlich HTTPS,
- Prüfung von Protokoll, Host, Port und Pfad statt eines einfachen Textvergleichs,
- keine Weiterleitung auf Redirect-Ziele,
- keine vom Aufrufer gesetzten Header wie `Authorization`, `Cookie` oder `Host`,
- Zeit- und Größenlimits für Requests und Antworten,
- kontrolliertes Streaming für Uploads und Downloads,
- keine Zugangsdaten oder Request-Bodies in Logs,
- Versand des Credentials nur nach erfolgreicher Prüfung der Connection Lease und der Ziel-URL.

Da der Provider-Request direkt von der CLI ausgeführt wird, besitzt Weldall kein verlässliches serverseitiges Audit über Antwortstatus und Dauer.

## Audit-Log

Connector- und Connection-Aktionen werden in das bestehende Weldall-Audit-Log geschrieben. Für V1 sind folgende Events sinnvoll:

### Connector-Verwaltung

- `connector.created`
- `connector.updated`
- `connector.deleted`

`connector.updated` umfasst auch Aktivierung, Deaktivierung und den Austausch des OAuth-Client-Secrets. Die Metadaten enthalten nur geänderte Feldnamen, Status vorher und nachher sowie `secretChanged`; Konfiguration und Secret-Werte werden nicht protokolliert.

### Connection-Lebenszyklus

- `connection.authorization_started`
- `connection.connected`
- `connection.authorization_failed`
- `connection.reconnected`
- `connection.disconnected`

Diese Events enthalten Connector- und PersonalConnection-ID, Besitzer und den auslösenden Akteur. Bestätigte Google-Account-ID und gewährte Scopes werden ergänzt, sobald sie vorliegen. `connection.disconnected` kann zusätzlich festhalten, ob der Widerruf bei Google versucht und bestätigt wurde.

### Credential-Erneuerung

- `connection_credential.refreshed`
- `connection_credential.refresh_failed`

Diese Events enthalten keine Access Tokens, Refresh Tokens oder OAuth-Autorisierungscodes.

### Connection-Nutzung

- `connection_lease.issued`
- `connection_lease.denied`
- `connection_lease.failed`

Lease-Events enthalten HTTP-Methode sowie normalisierten Host und Pfad. Query-Parameter, Fragmente, Header und Request-Bodies werden nicht protokolliert, da sie sensible Google-Daten enthalten können.

Alle Events verwenden die bestehenden Felder für Akteur, Request-ID, Zeitpunkt, Ergebnis und Reason Code. Erfolgreiche Aktionen und sicherheitsrelevante Ablehnungen müssen auditierbar sein; ein Fehler beim verpflichtenden Audit-Schreiben lässt die zugehörige sicherheitsrelevante Aktion fehlschlagen.

## Deaktivieren und Löschen

Ein deaktivierter Connector nimmt keine neuen Connections an und stellt keine Leases für bestehende Connections aus. Die Connections bleiben erhalten, damit der Connector später wieder aktiviert werden kann.

Ein Connector mit bestehenden Connections darf nicht stillschweigend gelöscht werden. Beim Löschen muss Weldall ausdrücklich festlegen, wie die Connections behandelt werden. Erfährt die CLI beim Disconnect oder bei einer Lease-Anfrage von einer gelöschten PersonalConnection, bereinigt sie ihren lokalen Keychain-Eintrag. Die serverseitige Sperre hängt niemals von dieser Bereinigung ab.

Diese Kontrolle gilt für die offizielle Weldall CLI. Ein aus der Keychain extrahiertes Credential kann außerhalb von Weldall weiterverwendet werden, bis es abläuft oder bei Google widerrufen wird.

## Späteres Teilen von Connections

Teilbare Accounts gehören nicht zu V1. Dafür wird später das eigenständige Primitive `SharedConnection` benötigt, bei dem das Credential verschlüsselt im Weldall-Backend liegt und Requests dort ausgeführt werden. PersonalConnections bleiben unverändert persönlich; es gibt keinen Moduswechsel und keine gemeinsame Tabelle mit optionalen Besitzer-/Gerätefeldern.

Eine SharedConnection könnte folgende Rechte erhalten:

- `use`: Requests über die Connection ausführen,
- `manage`: die Connection erneuern oder trennen,
- `share`: weiteren Nutzern oder Gruppen Zugriff geben.

Geteilt würde die Verwendung einer SharedConnection, niemals das Credential selbst. Bei jedem Request müssten der aufrufende Nutzer oder Service Principal und der verwendete Account beim Anbieter getrennt sichtbar bleiben. Nutzer-/Gruppen-Grants, zentraler Refresh, Credential-Rotation und der Entzug einzelner Grants gehören zu diesem neuen Lifecycle, nicht zum persönlichen Disconnect.

## Spätere externe Connectoren

Falls Connectoren später außerhalb des Weldall-Backends laufen sollen, kann eine weitere Implementierung dieselben Operationen an einen externen Dienst weiterleiten.

Erst dann wird ein Netzwerkprotokoll benötigt. Fragen wie Authentifizierung zwischen Diensten, Versionierung und Statusabgleich werden bewusst erst für diesen Anwendungsfall festgelegt.
