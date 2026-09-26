---
title: Connectors
description: Google-APIs im Namen der angemeldeten Person aufrufen.
---

Connectors rufen einen Dienst **im Namen der nutzenden Person** auf. Jede Person verbindet ihr eigenes Konto und gibt den Zugriff frei. Weldall speichert die Zugangsdaten verschlüsselt auf dem Server und führt die Aufrufe aus; Provider-Tokens gelangen nie in die CLI.

Google ist derzeit der einzige unterstützte Connector-OAuth-Client. Du möchtest einen anderen Dienst mit API-Token anbinden? Das geht schon heute über eine [Resource](../service-configuration/), die Anfragen weiterleitet und den Token serverseitig verwahrt. Connectors sind für persönliche, selbst freigegebene Zugriffe gedacht – nicht als Voraussetzung für jede Integration.

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

Mit `weldall connections disconnect my-google` entfernst du sie wieder. Weldall versucht, den Zugriff bei Google zu widerrufen, und löscht die gespeicherte Verbindung. Lässt sich der Widerruf nicht bestätigen, bittet dich die CLI, ihn in deinen Google-Kontoeinstellungen abzuschließen.

## Den Schlüssel sicher aufbewahren

Wenn du Connectors nutzt, setze **`WELDALL_CONNECTOR_KEK`** auf dem Weldall-Server: einen unabhängigen, Base64-kodierten Zufallsschlüssel mit 32 Bytes. Bewahre ihn unverändert in deinem Secret Manager auf, getrennt von Datenbank-Backups. Er ist nicht derselbe wie `WELDALL_CREDENTIAL_ENCRYPTION_KEY`, der OAuth-Client-Secrets schützt.

Aktuell nutzen Connectors `LOCAL_ENV`: Der KEK verschlüsselt die Schlüssel für die gespeicherten Verbindungszugangsdaten. **Wer sowohl die Datenbank als auch den KEK erbeutet, kann diese Zugangsdaten entschlüsseln.** Gegen diese Kombination schützt die Datenbankverschlüsselung allein nicht.

OpenBao-Integration und KMS-Unterstützung kommen bald; beides ist noch nicht verfügbar. Schlüsselrotation wird derzeit nicht unterstützt.
