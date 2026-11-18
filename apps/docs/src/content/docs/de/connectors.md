---
title: Connectors
description: Google- und Atlassian-Cloud-APIs im Namen der angemeldeten Person aufrufen und Apps auf GitHub veröffentlichen.
---

Connectors rufen einen Dienst **im Namen der nutzenden Person** auf. Jede Person verbindet ihr eigenes Konto und gibt den Zugriff frei. Weldall speichert die Zugangsdaten verschlüsselt auf dem Server und führt die Aufrufe aus; Provider-Tokens gelangen nie in die CLI.

Google und Atlassian Cloud (Jira und Confluence) werden als Connector-Provider unterstützt. Ein GitHub-App-Connector [veröffentlicht Apps auf GitHub](#apps-auf-github-veröffentlichen), auch für Personen ohne GitHub-Konto. Du möchtest einen anderen Dienst mit API-Token anbinden? Das geht schon heute über eine [Resource](../service-configuration/), die Anfragen weiterleitet und den Token serverseitig verwahrt.

Connectoren/geteilte Verbindungen können deaktiviert angelegt, in der UI provisioniert und anschließend ausdrücklich aktiviert werden. Provisionierung/Rotation aktiviert sie nicht; beide müssen für Aufrufe aktiv sein. [IaC](../infrastructure-as-code/#öffentliche-konfiguration-secrets-nur-in-der-ui) verwaltet öffentliche Konfiguration/Import, niemals Secrets.

## Google einrichten

Lege unter **Admin → Connectors** einen Google-Connector mit deiner Google-OAuth-Client-ID und dem Client-Secret an. Hinterlege `https://weldall.example.com/api/connectors/google/callback` bei Google als erlaubte Redirect-URI und ersetze die Domain durch deine Weldall-URL. Wähle die angebotenen Google-Berechtigungen und die nötigen Weldall-Scopes aus und aktiviere den Connector.

Danach können alle berechtigten Personen ihr eigenes Konto verbinden. Für einen Connector mit dem Key `google`:

```sh
weldall connectors
weldall connections connect google --name my-google
weldall request --connection my-google \
  https://www.googleapis.com/calendar/v3/calendars/primary/events
```

Gib beim Verbinden den Kalenderzugriff frei, um dieses Beispiel zu nutzen. Connector-Anfragen verwenden `--connection` statt `--scope`. Die Verbindung gehört dir und funktioniert auf allen Geräten, auf denen du angemeldet bist.

Der Google-Connector unterstützt außerdem OAuth-Berechtigungen für lesenden BigQuery-Zugriff, das Einfügen von Zeilen und die vollständige Verwaltung. Administratoren wählen aus, welche Berechtigungen angeboten werden; Nutzende sehen und bestätigen nur diese Auswahl. Eine Verbindung mit lesendem BigQuery-Zugriff kann beispielsweise eine Abfrage als verbundene Person ausführen, sodass deren zeilen- und spaltenbezogene BigQuery-Zugriffsregeln erhalten bleiben:

```sh
weldall request --connection my-google -X POST \
  --json '{"query":"SELECT name FROM `my-project.analytics.customers` LIMIT 10","useLegacySql":false,"maximumBytesBilled":"10000000"}' \
  https://bigquery.googleapis.com/bigquery/v2/projects/my-project/queries
```

Außerdem gibt es Drive-Lesezugriff, mit dem eine Verbindung Dateien auflistet und liest, sowie Sheets- und Docs-Berechtigungen, mit denen sie Tabellen und Dokumente liest und bearbeitet. Vollen Drive-Zugriff gibt es nicht. Einen Bereich aus einer bestehenden Tabelle und danach ein bestehendes Dokument lesen zum Beispiel:

```sh
weldall request --connection my-google \
  'https://sheets.googleapis.com/v4/spreadsheets/<spreadsheet-id>/values/Sheet1!A1:D20'
weldall request --connection my-google \
  https://docs.googleapis.com/v1/documents/<document-id>
```

Bestätige dafür beim Einrichten die passende Berechtigung. Tabellennamen mit Leerzeichen oder Sonderzeichen müssen URL-kodiert werden. Zellen schreibst du mit `-X PUT` auf dieselbe `values`-URL plus `?valueInputOption=RAW`. So wird Text unverändert gespeichert und nie als Formel ausgewertet.

Chat-Berechtigungen listen Spaces auf, lesen Nachrichten und senden Nachrichten im Namen der Person; zum Senden braucht das Google-Cloud-Projekt des OAuth-Clients eine konfigurierte Chat-App. Die neuesten Nachrichten eines Space listest du zum Beispiel so:

```sh
weldall request --connection my-google \
  'https://chat.googleapis.com/v1/spaces/<space-id>/messages?pageSize=20&orderBy=createTime%20DESC'
```

Außerdem gibt es Google-Ads-Zugriff. Google kennt dafür nur die Berechtigung `adwords`, die auch Änderungen erlaubt; eine Verbindung, die nur Berichte braucht, kann also trotzdem Kampagnen ändern. Im Google-Cloud-Projekt des OAuth-Clients muss die Google Ads API aktiv sein und eine Zugriffsstufe über Test haben; die beantragst du auf der Übersichtsseite der API in der Cloud Console. Einen Developer Token verlangt Google nicht mehr. Gib `login-customer-id` mit, wenn du das Konto über ein Verwaltungskonto erreichst. Eine GAQL-Suche zum Beispiel:

```sh
weldall request --connection my-google -X POST \
  -H 'login-customer-id: <manager-customer-id>' \
  --json '{"query":"SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS"}' \
  https://googleads.googleapis.com/v26/customers/<customer-id>/googleAds:search
```

Mit `weldall connections disconnect my-google` entfernst du sie wieder. Weldall versucht, den Zugriff bei Google zu widerrufen, und löscht die gespeicherte Verbindung. Lässt sich der Widerruf nicht bestätigen, bittet dich die CLI, ihn in deinen Google-Kontoeinstellungen abzuschließen.

## Atlassian Cloud einrichten

### 1. OAuth-App konfigurieren

Erstelle eine **ressourcenbezogene OAuth-2.0-Integration (3LO)** in der [Atlassian Developer Console](https://developer.atlassian.com/console/myapps/). Aktiviere die Freigabe, die benötigten Jira- oder Confluence-Berechtigungen und die User Identity API (`read:me`). Hinterlege `https://weldall.example.com/api/connectors/atlassian/callback` mit deiner Weldall-Domain als Callback. Weldall fordert `read:me` und `offline_access` automatisch an.

### 2. Unternehmens-Sites freigeben

Trage unter **Admin → Connectors → Atlassian Cloud** Client-ID und Client-Secret ein, wähle Produkte und Berechtigungen und aktiviere den Connector. Ergänze die erlaubten Site-Cloud-IDs. Die jeweilige `cloudId` findest du unter `https://your-site.atlassian.net/_edge/tenant_info`.

### 3. Konto verbinden

Für einen Connector namens `company-jira`:

```sh
weldall connections connect company-jira --name my-jira
weldall request --connection my-jira \
  https://api.atlassian.com/ex/jira/CLOUD_ID/rest/api/3/myself
```

Wähle auf Atlassians Freigabeseite eine Site. Weldall prüft sie gegen die Allowlist. Jede weitere Site benötigt eine eigene Verbindung. `weldall connections show my-jira` zeigt die Site-ID, fertige Request-Beispiele und Hinweise zur Paginierung. Mit `--agentic` erhältst du die Ausgabe für Agenten.

Requests verwenden `api.atlassian.com`, nicht die Domain der Site. Für Confluence-Seiten lautet der Pfad `/ex/confluence/CLOUD_ID/wiki/api/v2/pages`.

:::note[Verbindung entfernen]
`weldall connections disconnect my-jira` entfernt die Verbindung aus Weldall. Um den Atlassian-Zugriff zu widerrufen, entferne die App in deinen [Atlassian-Kontoeinstellungen](https://id.atlassian.com/manage-profile/apps). Das kann weitere Verbindungen derselben App betreffen.
:::

## Apps auf GitHub veröffentlichen

Eine Mitarbeiterin baut mit einem Agenten auf ihrem Rechner eine kleine App und bittet ihn, sie zu veröffentlichen. Ein GitHub-Konto hat sie nicht. Weldall legt für die App ein privates Repository in deiner GitHub-Organisation an, überträgt die Änderungen und öffnet einen Pull Request. Ein Reviewer in deiner Organisation gibt ihn auf GitHub frei und mergt ihn. Ohne diesen Pull Request gelangt nichts in den Default-Branch. Jede weitere Veröffentlichung schickt die nächste Änderung in dasselbe Repository, wieder als Pull Request.

Das übernimmt ein **GitHub-App-Connector**. Er hat keine persönlichen Verbindungen: Eine geteilte Verbindung verwahrt den privaten Schlüssel der App, und nur der Weldall-Server verwendet ihn. In `weldall connectors` taucht der Connector nicht auf. Die Einrichtung beschreibt [How to: GitHub anbinden](../github-app/).

### Was die Mitarbeiterin tut

Der Agent führt im Ordner der App einen Befehl aus. Beim ersten Veröffentlichen bekommt die App einen Namen und einen Zweck:

```sh
weldall app publish --name expenses --purpose "Track team expenses" --json
weldall app publish --title "Add receipt upload" --json
weldall app status --json
```

Jede Veröffentlichung holt den aktuellen Stand des Repositorys, führt ihn mit dem Ordner zusammen und schickt das Ergebnis als einen Commit auf einen Branch namens `weldall/publish-*`. Solange der vorige Pull Request offen ist, aktualisiert Publish ihn. Ist er gemergt oder geschlossen, öffnet die nächste Veröffentlichung einen neuen. Haben Ordner und Repository dieselben Zeilen geändert, hält Publish an und schickt nichts. Dateien, die nach Geheimnissen oder Daten aussehen, etwa `.env`-Dateien, private Schlüssel oder Datenbank-Dumps, lehnt Publish ebenfalls ab. `weldall app sync` holt nur den Stand des Repositorys in den Ordner. `weldall app status` zeigt den Pull Request mit Reviews und Checks sowie die Vorschau- und Live-Links, die die CI der App meldet. In einem Desktop-Client mit der Weldall-Erweiterung nutzt der Agent die Werkzeuge `publish_app` und `app_status`, die dieselben Befehle ausführen.

Jede veröffentlichte App steht in der [App-Registry](../app-registry/). Dort sehen Administratoren alle Apps, und Besitzer bestätigen alle 90 Tage, dass sie ihre Apps noch brauchen (`weldall app list`, `weldall app confirm`).

Autor der Commits ist das Bot-Konto der App, und jeder Commit trägt einen `Weldall-App:`-Trailer. Im Pull Request steht von der veröffentlichenden Person nur ihre Weldall-Nutzer-ID. Ihr Name steht im Audit-Log von Weldall.

### Der Git-Proxy

Git auf dem Rechner der Mitarbeiterin spricht nie mit GitHub. Es pusht zu Weldall und holt von dort, unter `https://weldall.example.com/git/<connector>/<owner>/<repository>.git`. Weldall prüft jede Anfrage, bevor es etwas weiterleitet:

- Die Person besitzt die App, die für dieses Repository registriert ist, und darf den Connector nutzen.
- Ein Push ändert nur Branches namens `weldall/publish-*`. Weldall lehnt Pushes auf den Default-Branch ab, ebenso Tags, das Löschen von Branches, Push-Optionen, signierte Pushes und Pushes auf den Branch eines geschlossenen oder gemergten Pull Requests. Git zeigt den Grund als `! [remote rejected] … (weldall: …)`.

Erst dann holt Weldall einen Installations-Token von GitHub für genau dieses Repository, mit Lese- oder Schreibrecht auf die Inhalte, und leitet die Anfrage als Stream an GitHub weiter. Der Token bleibt auf dem Server.

### Was auf den Rechner gelangt

Provider-Tokens gelangen nie in die CLI, auch bei GitHub nicht. Kein GitHub-Token verlässt den Weldall-Server.

Git kann die DPoP-gebundene Anmeldung von Weldall nicht senden. Deshalb arbeitet die CLI als Credential-Helper für Git (`weldall git-credential`). Für jeden Git-Befehl holt sie mit der bestehenden Anmeldung eine **Git-Anmeldung** bei Weldall und gibt sie Git als Passwort. Die Git-Anmeldung ist ein Geheimnis von Weldall, kein GitHub-Token:

- Sie gilt fünf Minuten lang, für das Repository einer App und für eine Person. Weldall speichert nur ihren Hash.
- Sie erlaubt nur Lesen, es sei denn, Publish fordert Schreibrecht an.
- Sie funktioniert nur am Git-Proxy von Weldall und unterliegt allen seinen Regeln. Die GitHub-API und andere Repositorys erreicht sie nicht.
- Anders als die Access Tokens von Weldall ist sie **nicht an den Geräteschlüssel gebunden**. Wer sie innerhalb dieser fünf Minuten kopiert, kann das Repository holen und, falls sie Schreibrecht gewährt, auf seine Publish-Branches pushen.

Git fragt den Helper nur für die Adresse des Proxys, und Publish leert für diese Adresse alle anderen Helper. Die Git-Anmeldung landet deshalb nicht im Schlüsselbund.

### Was Weldall protokolliert

Das Audit-Log enthält das Anlegen von Repositorys (`git_repository.*`), jeden Push vor dem Weiterleiten und sein Ergebnis (`git_push.*`, mit Person, Repository, Branch, altem und neuem Commit, Größe und Ergebnis), jeden Abruf (`git_fetch.*`), Pull Requests mit ihren Commits (`git_pull_request.*`), jede ausgegebene oder verweigerte Git-Anmeldung (`git_credential.*`) und jede Connector-Prüfung (`git_host.checked`). Auch Ablehnungen stehen darin. Ausgenommen ist die erste Anfrage jedes Git-Befehls, denn Git schickt sie immer ohne Anmeldung.

### Grenzen

| Grenze                          | Wert                                |
| ------------------------------- | ----------------------------------- |
| Anfrage eines Pushes            | 100 MiB                             |
| Antwort eines Abrufs            | 1 GiB                               |
| Dauer einer Git-Anfrage         | 280 Sekunden                        |
| Gleichzeitige Git-Übertragungen | 16 pro Server-Prozess, 4 pro Person |
| Git-Anmeldungen                 | 20 pro Person und Minute            |
| Dateien einer Veröffentlichung  | 10 MiB pro Datei, 100 MiB insgesamt |

Eine typische Veröffentlichung überträgt wenige Kilobyte. Publish braucht Git 2.39 oder neuer.

### Was Weldall nicht durchsetzen kann

Der Git-Proxy sieht, welchen Branch ein Push ändert, aber nicht, ob der Push Historie umschreibt. Einen Force-Push auf einen Publish-Branch erkennt er nicht. Die Rulesets deiner Organisation kann Weldall ebenfalls nicht lesen, nur die Regeln, die für ein bestehendes Repository gelten. Schütze den Default-Branch deshalb auf GitHub mit einer Regel, die einen geprüften Pull Request verlangt und Force-Pushes und Löschen verhindert. Die empfohlene Regel beschreibt [How to: GitHub anbinden](../github-app/#default-branch-schützen).

:::caution[Stand]
Veröffentlichen ist gegen eine nachgebildete GitHub-API und einen lokalen Git-Server getestet. Die einzelnen Bausteine wurden von Hand gegen github.com ausprobiert, der vollständige Ablauf lief aber noch nicht gegen github.com. GitHub Enterprise Cloud mit Datenresidenz (`https://api.<subdomain>.ghe.com`) akzeptiert die Konfiguration, getestet ist es aber nicht. GitHub Enterprise Server wird nicht unterstützt. Die Vorschau- und Live-Links hängen davon ab, dass die CI des App-Templates GitHub-Deployments meldet.
:::

## Anfragelimits

Weldall erlaubt **60 Anfragen pro Verbindung innerhalb eines 60-Sekunden-Zeitfensters**. Ist das Limit erreicht, antwortet Weldall mit HTTP `429`, bevor OpenBao oder der Provider kontaktiert werden. Anfragen, die diese Prüfung passieren, zählen auch dann, wenn sie später fehlschlagen. Das ist ein Limit von Weldall; die API-Limits des Providers gelten zusätzlich.

Pro Person sind außerdem höchstens **10 offene, noch nicht abgelaufene Verbindungsversuche** erlaubt, über alle Connectoren hinweg. Jeder Versuch ist zehn Minuten gültig. Brich unbenötigte Versuche ab oder warte, bis sie abgelaufen sind, bevor du einen weiteren startest.

## Zugangsdaten verschlüsseln

Weldall erzeugt bei jeder Speicherung einen neuen 32-Byte-Schlüssel und verschlüsselt damit die Zugangsdaten. Dieser Datenschlüssel (DEK) wird wiederum mit einem zweiten Schlüssel (KEK) verschlüsselt. Das Verfahren heißt **Envelope Encryption**.

In PostgreSQL liegen nur die verschlüsselten Zugangsdaten und der verschlüsselte DEK. Beim Lesen wird zuerst der DEK entschlüsselt, danach entschlüsselt Weldall damit die Zugangsdaten. Der KEK bleibt außerhalb der Datenbank. Ein gestohlenes Datenbank-Backup allein reicht deshalb nicht aus, um die Zugangsdaten zu lesen.

### Schlüssel verwalten

Beim Anlegen eines Connectors wählst du, wo der KEK verwaltet wird. Diese Auswahl lässt sich später nicht ändern, auch nicht per API oder IaC. Für einen Wechsel legst du einen neuen Connector an; die betroffenen Personen müssen ihre Konten dann erneut verbinden.

- **`LOCAL_ENV` (Standard):** Hinterlege den KEK in `WELDALL_CONNECTOR_KEK` auf dem Weldall-Server. Er muss aus 32 zufälligen Bytes bestehen, Base64-kodiert sein und unabhängig von den anderen Schlüsseln erzeugt werden. Alle `LOCAL_ENV`-Connectoren verwenden denselben KEK. Bewahre ihn unverändert im Secret Manager auf, getrennt von den Datenbank-Backups. Wer Datenbank und KEK besitzt, kann die Zugangsdaten dieser Connectoren entschlüsseln.
- **`OPENBAO`:** OpenBao verwaltet für jeden Connector einen eigenen Transit-Schlüssel vom Typ `aes256-gcm96` und legt ihn beim ersten Verschlüsseln an. Weldall ruft OpenBao einmal pro Schreibvorgang auf, um den DEK zu verschlüsseln, und einmal pro Lesevorgang, um ihn zu entschlüsseln. Du kannst den Transit-Schlüssel in OpenBao rotieren, ohne bereits gespeicherte Zugangsdaten neu zu verschlüsseln; sie bleiben lesbar.

OAuth-Client-Secrets verschlüsselt Weldall weiterhin mit `WELDALL_CREDENTIAL_ENCRYPTION_KEY`, unabhängig vom gewählten Envelope-Provider.

### OpenBao einrichten

Setze auf dem Weldall-Server die Adresse deines OpenBao-Servers und ein Zugriffstoken:

```dotenv
WELDALL_OPENBAO_HOST=https://openbao.example.com
WELDALL_OPENBAO_TOKEN=...
```

Aktiviere in OpenBao die Transit-Engine unter `transit/`. Das Token braucht nur diese Berechtigungen:

```hcl
path "transit/encrypt/weldall-connector-*" { capabilities = ["create", "update"] }
path "transit/decrypt/weldall-connector-*" { capabilities = ["update"] }
```

Weldall benötigt OpenBao nur beim Verschlüsseln und Entschlüsseln der Verbindungsdaten. Fehlt eine Variable, ist OpenBao nicht erreichbar oder wird das Token abgelehnt, schlägt der betroffene Vorgang mit HTTP `503` fehl. Die Fehlermeldung enthält keine geheimen Daten. Weldall startet trotzdem, Connectoren lassen sich weiterhin verwalten und `LOCAL_ENV`-Connectoren bleiben nutzbar.

Sichere OpenBao zusätzlich zur PostgreSQL-Datenbank. Weldall rotiert oder löscht keine Transit-Schlüssel automatisch. Wenn du einen Connector gelöscht hast und seinen Schlüssel nicht mehr brauchst, entferne den zugehörigen `weldall-connector-*`-Schlüssel selbst in OpenBao.
