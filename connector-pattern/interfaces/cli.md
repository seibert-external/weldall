# CLI-Interface für Weldall Connectors

## Ziel

Die CLI ermöglicht das Entdecken von Connectoren, das Verwalten von PersonalConnections und authentifizierte Requests über eine ausgewählte persönliche Connection. Die benutzerseitigen Namen `connections` und `--connection` bleiben bestehen; sie bezeichnen ausschließlich das persönliche Primitive.

Die URL beschreibt das logische Request-Ziel. Die PersonalConnection bestimmt den Provider-Account; lokale Credentials und direkte Requests sind fest Bestandteil dieses Primitives. Bei Connection-Requests werden keine Weldall-Scopes auf der Kommandozeile angegeben.

Die CLI und die Admin-UI verwenden dieselben serverseitigen Connector- und Connection-Verträge. Die Admin-UI bindet diese Verträge nach den bestehenden Weldall-Patterns über tRPC und TanStack Query an; Formulare verwenden TanStack Form und Listen TanStack Table. Ihre installationsweite Connection-Liste zeigt Administratoren alle Connections, während die CLI ausschließlich die persönlichen Connections des angemeldeten Nutzers anzeigt. CLI-Ausgaben und TanStack-UI-Zustand bleiben voneinander unabhängig.

## Connectoren entdecken

```sh
weldall connectors list
weldall connectors show google
```

`weldall connectors` ist ein Alias für `weldall connectors list`.

### `connectors list`

```text
╭─ Connectors ─────────────────────────────────────────────────────────╮
│ KEY              NAME                                               │
│ google           Google                                             │
╰──────────────────────────────────────────────────────────────────────╯
```

### `connectors show`

```text
╭─ Google ─────────────────────────────────────────────────────────────╮
│ Key              google                                             │
│ Enabled APIs     Gmail, Google Calendar                             │
│ Allowed targets  https://gmail.googleapis.com/gmail/v1/             │
│                  https://www.googleapis.com/calendar/v3/             │
╰──────────────────────────────────────────────────────────────────────╯
```

## Connections verwalten

```sh
weldall connections list
weldall connections show mein-google
weldall connections connect google --name mein-google
weldall connections reconnect mein-google
weldall connections rename mein-google google-arbeit
weldall connections disconnect mein-google
```

`weldall connections` ist ein Alias für `weldall connections list`. Diese Liste ist persönlich und nicht die installationsweite Admin-Ansicht.

Connection-Selektoren akzeptieren einen menschenlesbaren Namen oder eine stabile Connection-ID. Namen dienen der interaktiven Nutzung; für Automation sollte die ID verwendet werden.

### `connections list`

```text
╭─ Connections ───────────────────────────────────────────────────────────╮
│ NAME           CONNECTOR         ACCOUNT                         STATUS │
│ mein-google    Google            julian@gmail.com                ready  │
│ google-privat  Google            private@example.com               ready  │
╰─────────────────────────────────────────────────────────────────────────╯
```

### `connections show`

```text
╭─ Connection ─────────────────────────────────────────────────────────╮
│ Name             mein-google                                         │
│ ID               con_01JXYZ...                                       │
│ Connector        Google                                             │
│ Account          julian@gmail.com                                    │
│ Status           Ready                                               │
│ Credential location  Local on the connected device                   │
│ Enabled APIs     Gmail, Google Calendar                              │
│ Allowed targets  https://gmail.googleapis.com/gmail/v1/              │
│                  https://www.googleapis.com/calendar/v3/             │
│ Connected        2026-09-18 14:32                                    │
│ Last used        2026-09-18 16:08                                    │
╰───────────────────────────────────────────────────────────────────────╯
```

### `connections connect`

```sh
weldall connections connect google \
  --name mein-google
```

Auf einem interaktiven Terminal öffnet die CLI den vom Connector bereitgestellten Autorisierungsablauf im Browser und wartet auf dessen Abschluss.

```text
● Opening Google authorization in your browser…
✓ Connection "mein-google" is ready.
  Account: julian@gmail.com
```

V1 unterstützt ausschließlich PersonalConnections. Es gibt kein `--mode` und keine `credentialMode`-/`credentialModes`-Felder in den API-Verträgen. Der Connector liefert das Provider-Credential-Format; die persönliche CLI speichert es lokal.

### `connections reconnect`

Reconnect behält Connection-ID und Namen bei und ersetzt erst nach einem erfolgreich abgeschlossenen Verbindungsablauf die bestehenden Credentials.

```sh
weldall connections reconnect mein-google
```

```text
● Opening Google authorization in your browser…
✓ Connection "mein-google" was reconnected.
```

### `connections rename`

```sh
weldall connections rename mein-google google-arbeit
```

```text
✓ Renamed connection "mein-google" to "google-arbeit".
```

### `connections disconnect`

Disconnect löscht die PersonalConnection in Weldall und widerruft das Provider-Credential nach Möglichkeit. Die serverseitige Löschung geschieht unabhängig vom Remote-Widerruf und von der anschließenden lokalen Keychain-Bereinigung. Eine aufgegebene CLI kann die Löschung daher nicht verhindern.

```sh
weldall connections disconnect mein-google
```

```text
? Disconnect "mein-google" from julian@gmail.com? (y/N)
✓ Connection "mein-google" was disconnected.
```

Für nicht interaktive Aufrufe ist eine explizite Bestätigung erforderlich:

```sh
weldall connections disconnect mein-google --yes
```

## Requests über Connections

```sh
weldall request -c mein-google \
  https://www.googleapis.com/calendar/v3/users/me/calendarList
```

Dieselbe Google-Connection kann auch Gmail verwenden, wenn die benötigten Gmail-Scopes gewährt wurden:

```sh
weldall request -c mein-google \
  https://gmail.googleapis.com/gmail/v1/users/me/messages
```

```sh
weldall request \
  --connection mein-google \
  -X POST \
  --json '{"summary":"Planning"}' \
  https://www.googleapis.com/calendar/v3/calendars/primary/events
```

Auch stabile Connection-IDs sind erlaubt:

```sh
weldall request -c con_01JXYZ \
  https://www.googleapis.com/calendar/v3/users/me/calendarList
```

In V1 führt die CLI den Provider-Request direkt aus:

```text
PersonalConnection:
CLI ───────────────────────────────► Provider API
```

Eine spätere SharedConnection erhält einen eigenen Ausführungspfad über das Backend. Ihre CLI-Auswahl wird separat entworfen; sie ist kein weiterer Modus der bestehenden PersonalConnection. URL- und Ausgabe-Konventionen können gemeinsam bleiben.

Die Provider-Antwort bleibt unverändert auf `stdout`. Die CLI fügt keine Connection- oder Transport-Hülle hinzu. Bestehende Optionen für Methode, Header, Uploads, Formulardaten, Pagination und Ausgabedateien bleiben verwendbar.

### Abgrenzung zum bestehenden Resource Request

Connection- und Resource-Request sind zwei klar getrennte Modi:

```text
Connection Request:
  weldall request -c <connection> <absolute-url>
  --scope ist nicht erlaubt

Resource Request:
  weldall request --scope <scope> <absolute-url>
  --connection ist nicht erlaubt
```

Die Hilfe stellt diese Alternative explizit dar:

```text
Usage:
  weldall request (-c <connection> | -s <scope>...) [options] <url>

Options:
  -c, --connection  Connected account to use
  -s, --scope       Weldall resource scope; incompatible with --connection
```

### Sicherheitsregeln

- Die Ziel-URL muss absolut und per HTTPS erreichbar sein.
- Die Ziel-URL muss zu einem registrierten `allowedTargetPrefix` des Connectors passen.
- Zielvalidierung erfolgt vor Zugriff auf Provider-Credentials.
- Redirects werden nicht verfolgt.
- `Authorization`, `Cookie`, `Host` und andere transportkritische Header können nicht vom Aufrufer gesetzt werden.
- Die CLI löst Namen auf stabile Connection-IDs auf.
- Die Connection-ID wird an Lease oder Downstream-Autorisierung gebunden.
- Ein frei gesetzter Header darf keine andere Connection auswählen können.
- Bei PersonalConnections sendet die CLI Provider-Credentials ausschließlich an registrierte Provider-Ziele.

## Fehlerausgaben

Unbekannte Connection:

```text
× Error  Connection "mein-google" was not found.
Hint: Run `weldall connections list`.
```

Reconnect erforderlich:

```text
× Error  Connection "mein-google" requires authorization.
Hint: Run `weldall connections reconnect mein-google`.
```

Nicht erlaubtes Ziel:

```text
× Error  Connection "mein-google" cannot access https://mail.google.com/.
Hint: Allowed targets: https://gmail.googleapis.com/gmail/v1/, https://www.googleapis.com/calendar/v3/
```

Lokale Credentials fehlen auf diesem Gerät:

```text
× Error  Connection "google-privat" has no credentials on this device.
Hint: Run `weldall connections reconnect google-privat`.
```

Unvereinbare Optionen:

```text
× Error  --connection cannot be combined with --scope.
```

## Maschinenlesbare Ausgabe

`connectors list`, `connectors show`, `connections list` und `connections show` unterstützen `--json`.

```sh
weldall connections list --json
```

```json
{
  "connections": [
    {
      "id": "con_01JXYZ",
      "name": "mein-google",
      "connectorKey": "google",
      "account": {
        "displayName": "julian@gmail.com"
      },
      "status": "ready",
      "allowedTargetPrefixes": [
        "https://gmail.googleapis.com/gmail/v1/",
        "https://www.googleapis.com/calendar/v3/"
      ]
    }
  ]
}
```

Mögliche Statuswerte der ersten Implementierung:

- `ready`: PersonalConnection kann verwendet werden,
- `reconnect_required`: Provider-Autorisierung fehlt oder ist nicht mehr nutzbar.

Ein laufender Verbindungsablauf ist eine temporäre PersonalConnectionAuthorization, keine Connection mit `pending`-Status. Disconnect löscht die PersonalConnection statt einen `disconnected`-Datensatz zurückzulassen. Ein deaktivierter Connector blockiert die Verwendung seiner PersonalConnections.

## Umfang der ersten Implementierung

V1 enthält ausschließlich den Connector-Typ `google` mit Unterstützung für Gmail und Google Calendar sowie PersonalConnections mit lokalen Credentials. Andere Provider und SharedConnections sind nicht Teil dieser Version.

```text
connectors:  list, show
connections: list, show, connect, reconnect, rename, disconnect
request:     -c / --connection mit absoluter Provider-URL
```

Sharing und Service Accounts sind nicht Teil dieser CLI-Version. Die erste Implementierung zeigt und verwaltet ausschließlich persönliche Connections.
