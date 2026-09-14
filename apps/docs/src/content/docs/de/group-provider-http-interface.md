---
title: HTTP-Schnittstelle für Group Provider
description: Der HTTP-Vertrag für Gruppen- und Mitgliedschaftsdaten aus einem Group Provider.
sidebar:
  label: Group Provider API
---

Um unterschiedliche Active-Directory- und LDAP-Umgebungen anbinden zu können, liest Weldall Gruppen und aktuelle Mitgliedschaften über eine kleine HTTP-Schnittstelle. Der dafür eingesetzte Webservice implementiert die unten beschriebenen REST-Pfade und liefert die gezeigten JSON-Antworten.

Administratoren hinterlegen den HTTPS-Origin und ein Token unter **Group providers**.

:::note[Active Directory und LDAP]
Die HTTP-Schnittstelle ist bewusst klein gehalten, damit unterschiedliche Active-Directory- und LDAP-Varianten angebunden werden können. Bietet das Verzeichnis diese REST-Pfade nicht selbst an, übersetzt ein zusätzlicher Proxy zwischen der Schnittstelle und LDAP.
:::

## Authentifizierung

Weldall sendet jeden Request mit diesen Headern:

```http
Authorization: Token <konfiguriertes Token>
Accept: application/json
```

Die Basis-URL muss ein HTTPS-Origin ohne Zugangsdaten, Pfad, Query oder Fragment sein, zum Beispiel `https://groups.example.com`. Weldall hängt die folgenden Pfade an diesen Origin an.

## Gruppen auflisten

```http
GET <baseUrl>/api/management/groups/
```

```json
[
  {
    "ou": "finance",
    "cn": "Finance",
    "description": "Finance team"
  }
]
```

| Feld          | Bedeutung                                                                          |
| ------------- | ---------------------------------------------------------------------------------- |
| `ou`          | Erforderliche, stabile Gruppen-ID. Groß- und Kleinschreibung werden unterschieden. |
| `cn`          | Optionaler Anzeigename. Fehlt er oder ist er leer, verwendet Weldall `ou`.         |
| `description` | Optionale Beschreibung. `null` ist zulässig.                                       |

Weldall verwendet diese Liste für Verbindungstests und optionale Gruppensuchen. Beim Erstellen von Zuweisungen behandelt Weldall Gruppen-IDs als opak und ruft den Provider nicht auf. Die Suche erfolgt lokal über ID, Name und Beschreibung. Die Antwort darf höchstens 10.000 Gruppen enthalten.

## Eine Gruppe lesen

```http
GET <baseUrl>/api/management/groups/<url-kodierte-gruppen-id>/
```

Die Antwort enthält dasselbe Objektformat wie ein Eintrag der Gruppenliste. `ou` muss genau der angefragten Gruppen-ID entsprechen.

## Nutzer über die E-Mail-Adresse finden

```http
GET <baseUrl>/api/management/users/?mail=<url-kodierte-normalisierte-email>
```

Weldall entfernt Leerzeichen am Rand, schreibt die E-Mail-Adresse klein und verwendet den Query-Parameter `mail`.

```json
[
  {
    "username": "jane.doe",
    "email": "jane.doe@example.com",
    "is_active": true,
    "avatar_url": "https://photos.example.com/jane.doe.png"
  }
]
```

Die Antwort muss ein Array mit keinem oder genau einem Treffer sein. Ohne Treffer vergibt der Provider keine gruppenbasierten Scopes. Mehrere Treffer oder eine abweichende E-Mail-Adresse werden abgelehnt.

| Feld         | Bedeutung                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `username`   | Erforderliche, stabile ID des Nutzers beim Provider.                                                                                         |
| `email`      | Erforderliche E-Mail-Adresse des Nutzers.                                                                                                    |
| `is_active`  | Nur aktive Nutzer können gruppenbasierte Scopes erhalten.                                                                                    |
| `avatar_url` | Optionales Profilbild. Weldall verwendet nur absolute HTTPS-URLs und ignoriert einen fehlenden oder unbrauchbaren Wert. `null` ist zulässig. |

## Nutzer mit Gruppen lesen

```http
GET <baseUrl>/api/management/users/<url-kodierte-nutzer-id>/
```

```json
{
  "username": "jane.doe",
  "email": "jane.doe@example.com",
  "is_active": true,
  "avatar_url": "https://photos.example.com/jane.doe.png",
  "groups": ["finance", "employees"]
}
```

`username` und die normalisierte `email` müssen dem vorherigen Suchtreffer entsprechen. Der Nutzer muss weiterhin aktiv sein. `groups` enthält die effektiven Gruppen-IDs des Nutzers und darf höchstens 10.000 Einträge enthalten. Weldall löst verschachtelte Gruppen nicht selbst auf.

## Antwortregeln und Grenzen

Alle Endpunkte müssen mit einem erfolgreichen HTTP-Status und `Content-Type: application/json` antworten. Zusätzliche Objektfelder sind erlaubt, werden aber verworfen.

- Gruppen-IDs, Nutzernamen und Einträge in `groups` enthalten nach dem Trimmen 1 bis 191 Zeichen.
- Gruppennamen enthalten höchstens 191 Zeichen, Beschreibungen höchstens 2.000 Zeichen.
- E-Mail-Adressen müssen gültig sein und dürfen höchstens 320 Zeichen enthalten.
- `avatar_url` muss eine absolute HTTPS-URL ohne Zugangsdaten oder Fragment sein und darf höchstens 2.048 Zeichen enthalten.
- Eine Antwort darf höchstens 5 MiB groß sein und muss innerhalb von 5 Sekunden eintreffen.
- Weldall folgt keinen Redirects, wiederholt fehlgeschlagene Requests nicht und speichert Antworten des Providers nicht serverseitig zwischen. Gespeichert wird nur die für einen Nutzer gemeldete `avatar_url`, damit die Web-Oberfläche den Avatar über den eigenen Origin ausliefern kann.

Bei jeder neuen Autorisierungsentscheidung fragt Weldall die Mitgliedschaft erneut ab. Fehlerhafte Antworten, inaktive Nutzer, Timeouts und Fehler des Providers erzeugen keine gruppenbasierten Scopes. Ein unbrauchbarer `avatar_url` wird verworfen und lässt eine Abfrage nie fehlschlagen.

:::note[Avatare]
Avatare sind optional und werden nur von der Weldall-Web-Oberfläche genutzt. Weldall ruft die `avatar_url` ohne das Provider-Token ab, sie muss also ohne Zugangsdaten unter einer öffentlichen Adresse erreichbar sein. Redirects werden nicht verfolgt und es werden nur Rasterbilder mit höchstens 512 KiB ausgeliefert; der Browser kontaktiert den Provider nie direkt. Jeder angemeldete Nutzer darf einen Avatar lesen, ein zusätzlicher Scope ist nicht erforderlich. Nutzer ohne nutzbaren Avatar erscheinen mit ihren Initialen.
:::

:::note[Effektive Scopes]
Die effektiven Scopes eines Mitarbeiters sind die Vereinigung aus Gruppen-Scopes und direkt seiner E-Mail-Adresse zugewiesenen Scopes. Ist der Provider vorübergehend nicht erreichbar, bleiben die E-Mail-Scopes verfügbar.
:::
