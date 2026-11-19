---
title: App-Registry
description: Jede über eine Git-App veröffentlichte App, wem sie gehört, wofür sie da ist und wann ihr Besitzer sie wieder bestätigen muss.
sidebar:
  label: App-Registry
---

Jede App, die eine Mitarbeitende über eine [Git-App](../git-app/) veröffentlicht, steht ab der ersten Veröffentlichung in der App-Registry dieser Git-App. Administratoren sehen, was es gibt, wem es gehört, wofür es da ist und welche Apps länger niemand bestätigt hat. Jede Git-App führt die Registry ihrer Apps in ihrer eigenen Datenbank. Weldall speichert keine Apps, sein Audit-Log hält aber jede Registrierung und Bestätigung fest.

## Was festgehalten wird

Die Git-App legt den Eintrag an, wenn sie das Repository der App anlegt. Niemand muss eine App von Hand eintragen. Ein Administrator kann außerdem ein bestehendes Repository der Organisation als App registrieren (`POST /api/admin/apps`, siehe die [README](https://github.com/seibert-external/weldall-git-app#api) der Git-App).

| Feld              | Bedeutung                                                                          |
| ----------------- | ---------------------------------------------------------------------------------- |
| Name              | Der Name aus der ersten Veröffentlichung                                           |
| Besitzer          | Die Weldall-Person, die die App zuerst veröffentlicht hat                          |
| Zweck             | Wofür die App da ist, in den Worten des Besitzers                                  |
| Repository        | Organisation und Repository auf dem Host der Git-App, mit Link                     |
| Template          | Das Template, mit dem die App begonnen hat                                         |
| Vorschau, Live    | Die Links, die die CI der App meldet; die Git-App behält nur `https`-Links         |
| Angelegt          | Wann der Eintrag entstand                                                          |
| Zuletzt bestätigt | Wann der Besitzer die App zuletzt bestätigt hat; leer bis zur ersten Bestätigung   |
| Läuft ab          | Bis wann der Besitzer die App wieder bestätigen muss                               |
| Zustand           | `active`, `expiring_soon` oder `expired`, bei jedem Lesen aus dem Ablauf berechnet |

Name, Zweck und Links stammen von Menschen oder aus der CI der App. Zeige sie als reinen Text, nie als Markup.

## Erneute Bestätigung

Eine neue App läuft 90 Tage nach ihrer ersten Veröffentlichung ab. Vorher bestätigt der Besitzer, dass er sie noch braucht:

```sh
weldall app list
weldall app confirm <app-id>
```

`weldall app list` fragt jede Git-App, über die der Besitzer veröffentlichen darf, und zeigt seine Apps mit Zustand und Ablauf, den frühesten Ablauf zuerst. `weldall app confirm` setzt den Ablauf auf 90 Tage ab jetzt und hält fest, wann und von wem. Im Ordner der App bestätigt `weldall app confirm` ohne ID die App dieses Ordners bei ihrer Git-App; mit einer ID findet die CLI die Git-App, deren Registry die App führt, oder nimmt `--git-app <resource key>`. Beide Befehle kennen `--json`. In einem Desktop-Client mit der Weldall-Erweiterung kann der Agent die Apps mit dem Werkzeug `list_apps` auflisten und der Person sagen, welche eine Bestätigung brauchen. Mit `confirm_app` bestätigt er eine App nur, wenn die Person ihn darum bittet.

Veröffentlichen bestätigt eine App **nicht**. Die Bestätigung ist eine bewusste Handlung des Besitzers. So bleibt eine App, die zwar weiter geändert, aber nicht mehr auf ihren Bedarf geprüft wird, nicht aus Versehen aktiv.

Der Zustand folgt aus dem Ablauf:

| Zustand         | Wann                                                     |
| --------------- | -------------------------------------------------------- |
| `active`        | Mehr als 14 Tage vor dem Ablauf                          |
| `expiring_soon` | 14 Tage oder weniger vor dem Ablauf                      |
| `expired`       | Ab dem Ablauf, bis der Besitzer die App wieder bestätigt |

### Was „abgelaufen“ bedeutet

Eine abgelaufene App wird **nur markiert**. Nichts stoppt, löscht oder sperrt sie: Ihr Besitzer kann weiter veröffentlichen, die Git-App nimmt weiter Pushes an, und die App läuft weiter, wo immer sie läuft. Administratoren sehen die Markierung in der API der Git-App und entscheiden, was zu tun ist. Niemand wird benachrichtigt. Der Besitzer sieht den Zustand mit `weldall app list`.

## Wer was sieht

Gelesen wird alles über die API der Git-App an ihrem Origin, zum Beispiel `https://git-app.example.com/api`. Person oder Machine braucht den Scope an der Resource der Git-App in Weldall:

- **Der Besitzer** (`git-app:publish`) sieht und bestätigt nur seine eigenen Apps: `GET /api/apps` und `POST /api/apps/{id}/confirm`, die `weldall app list` und `weldall app confirm` aufrufen. Eine unbekannte App-ID und die App einer anderen Person bekommen dieselbe Antwort.
- **Administratoren** (`git-app:admin`) sehen alle Apps mit Besitzer (Weldall-Benutzer-ID und E-Mail-Adresse), wer sie registriert und wer sie zuletzt bestätigt hat: `GET /api/admin/apps`, abgelaufene und bald ablaufende Apps zuerst, filterbar mit `state`, durchsuchbar mit `q` (App, Zweck, Repository, Besitzer), seitenweise mit `page` und `pageSize`. Eine Admin-Seite gibt es noch nicht. Der Agent eines Administrators ruft die Liste mit `weldall request` ab, angeleitet vom Skill `<resource key>.admin-apps` der Git-App.
- **Eure eigenen Werkzeuge** lesen die ganze Registry über einen Machine Client mit `git-app:registry-read` (siehe unten).

Sonst sieht niemand die Registry. Registrierungen, Bestätigungen und abgelehnte Bestätigungen stehen im Audit-Log von Weldall als `git_repository.created`, `git_repository.registered`, `app_confirmation.succeeded` und `app_confirmation.denied`.

## Die Registry aus eigenen Werkzeugen lesen

Ein Backend, ein Skript oder ein CMDB-Import liest die Registry per [Machine-Authentifizierung](../machine-authentication/). Registriere einen Machine Client und erlaube ihm die Resource der Git-App und den Scope `git-app:registry-read`, unter **Machine clients** oder per IaC:

```yaml
machines:
  registry-export:
    clientId: registry-export
    name: App registry export
    enabled: true
    publicKeys:
      current: { kty: EC, crv: P-256, x: "…", y: "…" }
    resources: [git-app]
    scopes: ["git-app:registry-read"]
```

Der Machine Client fordert einen Token für die Resource der Git-App an (`requestMachineToken` mit `git-app:registry-read`) und liest die Registry bei der Git-App. Bei mehreren Git-Apps liest er jede Registry mit einem eigenen Token. Den Endpunkt, das Blättern und die Felder eines Eintrags beschreibt die [README](https://github.com/seibert-external/weldall-git-app#api) der Git-App.
