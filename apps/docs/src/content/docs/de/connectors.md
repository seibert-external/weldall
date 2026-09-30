---
title: Connectors
description: Google- und Atlassian-Cloud-APIs im Namen der angemeldeten Person aufrufen.
---

Connectors rufen einen Dienst **im Namen der nutzenden Person** auf. Jede Person verbindet ihr eigenes Konto und gibt den Zugriff frei. Weldall speichert die Zugangsdaten verschlüsselt auf dem Server und führt die Aufrufe aus; Provider-Tokens gelangen nie in die CLI.

Google und Atlassian Cloud (Jira und Confluence) werden als Connector-Provider unterstützt. Du möchtest einen anderen Dienst mit API-Token anbinden? Das geht schon heute über eine [Resource](../service-configuration/), die Anfragen weiterleitet und den Token serverseitig verwahrt. Connectors sind für persönliche, selbst freigegebene Zugriffe gedacht – nicht als Voraussetzung für jede Integration.

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
