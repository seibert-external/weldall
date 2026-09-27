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

## Zwei Schlüssel, ein kleiner Umschlag

Weldall nutzt **Envelope Encryption**. Stell dir gespeicherte Zugangsdaten als verschlossenes Paket vor:

1. Bei jedem Schreiben erzeugt Weldall einen frischen 32-Byte-**DEK** (Data Encryption Key) und verschlüsselt damit die Zugangsdaten lokal.
2. Ein **KEK** (Key Encryption Key) wrappt diesen DEK. In PostgreSQL landen nur die verschlüsselten Zugangsdaten und der gewrappte DEK.
3. Beim Lesen entpackt der gewählte Provider den DEK; Weldall entschlüsselt damit die Zugangsdaten lokal.

Warum zwei Schlüssel? Ein frischer DEK begrenzt, was ein einzelner Datenschlüssel öffnen kann, während der KEK außerhalb von PostgreSQL bleibt. Ein Datenbank-Backup allein reicht deshalb nicht, um Zugangsdaten zu lesen. OpenBao kann seine KEKs außerdem rotieren, ohne gespeicherte Zugangsdaten neu zu verschlüsseln.

### Den KEK-Halter einmal wählen

Der Envelope-Provider ist nach dem Anlegen dauerhaft: Weder UI noch API oder IaC können `LOCAL_ENV` zu `OPENBAO` ändern oder zurück. Für einen Wechsel legst du einen neuen Connector an und verbindest die Benutzer neu.

- **`LOCAL_ENV` (Standard)** hält einen gemeinsamen KEK in `WELDALL_CONNECTOR_KEK`, einem unabhängigen, Base64-kodierten 32-Byte-Schlüssel. Bewahre ihn unverändert in deinem Secret Manager und getrennt von Datenbank-Backups auf. Wer Datenbank und KEK besitzt, kann alle Zugangsdaten der `LOCAL_ENV`-Connectoren entschlüsseln.
- **`OPENBAO`** hält pro Connector einen eigenen `aes256-gcm96`-Transit-KEK. OpenBao legt ihn beim ersten Einsatz an; jeder geschützte Schreibvorgang braucht eine Encrypt-Anfrage, jeder Lesevorgang eine Decrypt-Anfrage. Du kannst ihn jederzeit in OpenBao rotieren—alte Ciphertexte funktionieren weiter. Weldall rotiert oder löscht Transit-Schlüssel nie.

`WELDALL_CREDENTIAL_ENCRYPTION_KEY` bleibt separat und schützt weiterhin OAuth-Client-Secrets. OpenBao schützt nur die Zugangsdaten der Benutzerverbindungen.

### OpenBao einrichten

Richte Weldall auf deinen Server und gib ihm ein Data-Plane-Token:

```dotenv
WELDALL_OPENBAO_HOST=https://openbao.example.com
WELDALL_OPENBAO_TOKEN=...
```

Aktiviere zuerst die Transit-Engine und erlaube nur die benötigten Pfade:

```hcl
path "transit/encrypt/weldall-connector-*" { capabilities = ["create", "update"] }
path "transit/decrypt/weldall-connector-*" { capabilities = ["update"] }
```

OpenBao wird nur kontaktiert, wenn Zugangsdaten verschlüsselt oder entschlüsselt werden müssen. Fehlende Variablen, Ausfälle oder ein abgelehntes Token lassen nur diese Operation mit einem bereinigten `503` scheitern; Start, Connector-Verwaltung und `LOCAL_ENV`-Connectoren funktionieren weiter. Sichere OpenBao unabhängig von PostgreSQL und entferne übrig gebliebene `weldall-connector-*`-Schlüssel nach dem Löschen eines Connectors selbst.

KMS-Unterstützung kommt weiterhin bald.
