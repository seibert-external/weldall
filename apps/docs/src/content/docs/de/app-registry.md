---
title: App-Registry
description: Jede über Weldall veröffentlichte App, wem sie gehört, wofür sie da ist und wann ihr Besitzer sie wieder bestätigen muss.
sidebar:
  label: App-Registry
---

Jede App, die eine Mitarbeiterin [über Weldall veröffentlicht](../connectors/#apps-auf-github-veröffentlichen), steht ab der ersten Veröffentlichung in der App-Registry. Die IT sieht, was es gibt, wem es gehört, wofür es da ist und welche Apps länger niemand bestätigt hat.

## Was festgehalten wird

Weldall legt den Eintrag an, wenn es das Repository der App anlegt. Niemand muss eine App von Hand eintragen.

| Feld              | Bedeutung                                                                          |
| ----------------- | ---------------------------------------------------------------------------------- |
| Name              | Der Name aus der ersten Veröffentlichung                                           |
| Besitzer          | Die Weldall-Person, die die App zuerst veröffentlicht hat                          |
| Zweck             | Wofür die App da ist, in den Worten des Besitzers                                  |
| Repository        | Git-Host-Connector, Organisation und Repository, mit Link zum Host                 |
| Template          | Das Template, mit dem die App begonnen hat                                         |
| Vorschau, Live    | Die Links, die die CI der App meldet; Weldall zeigt nur `https`-Links              |
| Angelegt          | Wann der Eintrag entstand                                                          |
| Zuletzt bestätigt | Wann der Besitzer die App zuletzt bestätigt hat; leer bis zur ersten Bestätigung   |
| Läuft ab          | Bis wann der Besitzer die App wieder bestätigen muss                               |
| Zustand           | `active`, `expiring_soon` oder `expired`, bei jedem Lesen aus dem Ablauf berechnet |

Name, Zweck und Links stammen von Menschen oder aus der CI der App. Weldall zeigt sie als reinen Text, nie als Markup.

## Erneute Bestätigung

Eine neue App läuft 90 Tage nach ihrer ersten Veröffentlichung ab. Vorher bestätigt der Besitzer, dass er sie noch braucht:

```sh
weldall app list
weldall app confirm <app-id>
```

`weldall app list` zeigt die Apps des Besitzers mit Zustand und Ablauf, abgelaufene und bald ablaufende zuerst. `weldall app confirm` setzt den Ablauf auf 90 Tage ab jetzt und hält fest, wann und von wem. Im Ordner der App bestätigt `weldall app confirm` ohne ID die App dieses Ordners. Beide Befehle kennen `--json`. In einem Desktop-Client mit der Weldall-Erweiterung kann der Agent die Apps mit dem Werkzeug `list_apps` auflisten und der Person sagen, welche eine Bestätigung brauchen. Mit `confirm_app` bestätigt er eine App nur, wenn die Person ihn darum bittet.

Veröffentlichen bestätigt eine App **nicht**. Die Bestätigung ist eine bewusste Handlung des Besitzers. So bleibt eine App, die zwar weiter geändert, aber nicht mehr auf ihren Bedarf geprüft wird, nicht aus Versehen aktiv.

Der Zustand folgt aus dem Ablauf:

| Zustand         | Wann                                                     |
| --------------- | -------------------------------------------------------- |
| `active`        | Mehr als 14 Tage vor dem Ablauf                          |
| `expiring_soon` | 14 Tage oder weniger vor dem Ablauf                      |
| `expired`       | Ab dem Ablauf, bis der Besitzer die App wieder bestätigt |

### Was „abgelaufen“ bedeutet

Eine abgelaufene App wird **nur markiert**. Weldall stoppt, löscht und sperrt sie nicht: Ihr Besitzer kann weiter veröffentlichen, der Git-Proxy nimmt weiter Pushes an, und die App läuft weiter, wo immer sie läuft. Die IT sieht die Markierung in der Admin-Liste und in der API und entscheidet, was zu tun ist. Weldall verschickt keine Benachrichtigung. Der Besitzer sieht den Zustand mit `weldall app list`.

## Wer was sieht

- **Der Besitzer** sieht und bestätigt nur seine eigenen Apps. Eine unbekannte App-ID und die App einer anderen Person bekommen dieselbe Antwort.
- **Administratoren** sehen alle Apps unter **App registry** im Admin-Bereich von Weldall: Name, Besitzer, Zweck, Repository, Template, Vorschau- und Live-Link, angelegt, zuletzt bestätigt, Ablauf und Zustand. Abgelaufene und bald ablaufende Apps stehen oben. Die Liste lässt sich nach Zustand filtern und nach App, Zweck, Repository und Besitzer durchsuchen. Sie ist nur zum Lesen.
- **Eure eigenen Werkzeuge** lesen die Registry über einen Machine Client mit dem Scope `weldall:app-registry-read` (siehe unten).

Sonst sieht niemand die Registry. Bestätigungen und abgelehnte Bestätigungen stehen im Audit-Log als `app_confirmation.succeeded` und `app_confirmation.denied`.

## Die Registry aus eigenen Werkzeugen lesen

Ein Backend, ein Skript oder ein CMDB-Import liest die Registry mit [Machine Authentication](../machine-authentication/). Lege einen Machine Client an und erlaube ihm den System-Scope `weldall:app-registry-read`, der nur für Maschinen gilt. Das geht unter **Machine clients** oder per IaC:

```yaml
machines:
  registry-export:
    clientId: registry-export
    name: App registry export
    enabled: true
    publicKeys:
      current: { kty: EC, crv: P-256, x: "…", y: "…" }
    resources: []
    scopes: ["weldall:app-registry-read"]
```

Die Maschine fordert ein Token für die Weldall-API an und ruft `GET /api/app-registry/v1/apps` auf:

```ts
import { createDpopProof, requestMachineToken } from "@weldall/sdk";

const issuer = "https://weldall.example.com";
const token = await requestMachineToken({
  issuer,
  clientId: "registry-export",
  resource: `${issuer}/api`,
  scopes: ["weldall:app-registry-read"],
  kid: process.env.MACHINE_SIGNING_KID!,
  key,
});
const apps = [];
let cursor: string | null = null;
do {
  const url = `${issuer}/api/app-registry/v1/apps?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const response = await fetch(url, {
    headers: {
      authorization: `DPoP ${token.accessToken}`,
      dpop: await createDpopProof({ ...key, method: "GET", url, accessToken: token.accessToken }),
    },
  });
  const page = await response.json();
  apps.push(...page.apps);
  cursor = page.nextCursor;
} while (cursor);
```

Query-Parameter, jeder höchstens einmal:

| Parameter | Bedeutung                                                            |
| --------- | -------------------------------------------------------------------- |
| `limit`   | Einträge pro Seite, 1 bis 200; Standard 100                          |
| `cursor`  | Der `nextCursor` der vorigen Seite                                   |
| `state`   | Nur Apps in diesem Zustand: `active`, `expiring_soon` oder `expired` |

Die Antwort listet die Apps in der Reihenfolge ihres Anlegens, die älteste zuerst. Neue Apps kommen also hinten dazu, und beim Blättern wird kein Eintrag doppelt geliefert oder übersprungen. Auf der letzten Seite ist `nextCursor` gleich `null`. Alle Zeitangaben sind ISO 8601 in UTC.

```json
{
  "apps": [
    {
      "id": "cm3k9x2f80001",
      "name": "expense-tracker",
      "purpose": "Tracks team expenses until the finance tool supports receipts.",
      "owner": { "id": "u_8f2c", "email": "jane.adams@example.com" },
      "repository": {
        "connector": "github-apps",
        "resource": null,
        "owner": "acme-apps",
        "name": "app-expense-tracker",
        "webUrl": "https://github.com/acme-apps/app-expense-tracker"
      },
      "template": "react",
      "links": { "preview": null, "live": "https://expense-tracker.example.com/" },
      "createdAt": "2026-11-02T09:14:00.000Z",
      "confirmedAt": null,
      "expiresAt": "2027-01-31T09:14:00.000Z",
      "state": "active"
    }
  ],
  "nextCursor": null,
  "generatedAt": "2026-11-18T08:00:00.000Z",
  "reverificationDays": 90,
  "expiringSoonDays": 14
}
```

`repository.connector` nennt den Git-Host-Connector, in dem das Repository liegt. Bei einer App, die über eine eigene, als Ressource registrierte Git-App veröffentlicht wurde, ist `connector` `null` und `repository.resource` enthält den Schlüssel der Ressource. Genau eines der beiden Felder ist gesetzt.

Den Besitzer gibt die API als Weldall-User-ID und E-Mail-Adresse an, nicht mit Namen. Über die E-Mail-Adresse erreicht die IT die Person und findet sie im eigenen Verzeichnis. Die ID bleibt gleich, wenn sich die Adresse ändert. Den Namen kennt das Verzeichnis schon, deshalb lässt die API ihn weg.

Ein Token ohne `weldall:app-registry-read` bekommt `403 insufficient_scope`, ein fehlendes oder ungültiges Machine-Token `401`. Die OAuth-Metadaten kündigen den Endpunkt als `weldall_app_registry` an. Ein Weldall-Server ohne App-Registry kennt den Scope nicht. Eine Token-Anfrage dafür scheitert dann mit `invalid_scope`.
