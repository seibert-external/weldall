---
title: "How to: Git-App betreiben"
description: Die Git-App betreiben, die die Repositorys veröffentlichter Apps auf deinem GitHub oder Forgejo verwaltet, und sie in Weldall registrieren.
sidebar:
  label: "How to: Git-App betreiben"
---

Mitarbeitende [veröffentlichen Apps](../publish-apps/), die sie mit einem Agenten gebaut haben, auf dem Git-Host deiner Organisation. Die Arbeit auf dem Git-Host erledigt die **Git-App**: Sie legt die Repositorys an, stellt Git für sie bereit und öffnet die Pull Requests. Sie ist ein eigener Dienst, den deine Organisation neben Weldall betreibt, eine Instanz pro Git-Host, und den du in Weldall als [Resource](../service-configuration/) registrierst. Ihr Code, ihr Docker-Image und ihre Betriebsanleitung liegen in einem eigenen Repository, [seibert-external/weldall-git-app](https://github.com/seibert-external/weldall-git-app).

So sind die Aufgaben verteilt:

- **Die Git-App** verwahrt das Secret des Git-Hosts (den privaten Schlüssel der GitHub App oder den Access Token des Forgejo-Bot-Benutzers). Das Secret verlässt sie nie. Außerdem führt sie die [App-Registry](../app-registry/) in ihrer eigenen PostgreSQL-Datenbank.
- **Weldall** entscheidet, wer veröffentlichen darf, und speichert das Audit-Log. Die Git-App fragt Weldall bei jeder Anfrage und meldet jedes angelegte Repository, jeden Push und Abruf, jeden Pull Request, jede Git-Anmeldung und jede Bestätigung einer App. Weldall selbst speichert keine Apps.

Diese Anleitung richtet sich an die Administratoren, die die Git-App betreiben und in Weldall registrieren. Die Schritte für den jeweiligen Host stehen in [How to: GitHub anbinden](../github-app/) und [How to: Forgejo anbinden](../forgejo/).

## Voraussetzungen

- Ein laufendes Weldall und Administratorzugriff darauf.
- Ein öffentlicher HTTPS-Origin für die Git-App, zum Beispiel `https://git-app.example.com`. Die Git-App muss an der Wurzel dieses Origins erreichbar sein, nicht unter einem Pfad. Terminiere TLS vor dem Container.
- Eine PostgreSQL-Datenbank für die App-Registry der Git-App, eine pro Git-App.
- Den Git-Host, vorbereitet wie in [How to: GitHub anbinden](../github-app/) oder [How to: Forgejo anbinden](../forgejo/) beschrieben. Von dort bringst du die Host-Konfiguration und das Host-Secret mit.

Die Geräte der Mitarbeitenden erreichen die Git-App über HTTPS. Die Git-App erreicht Weldall, ihre Datenbank und den Git-Host, und Weldall erreicht die Git-App, um ihre Skills zu finden.

## 1. Git-App betreiben

Wie du die Git-App betreibst, beschreibt ihre [README](https://github.com/seibert-external/weldall-git-app#readme) (auf Englisch): die Schlüssel, die du erzeugst (ein Signaturschlüssel für ihren eigenen Authorization Server, ein Machine-Schlüssel für ihren Machine-Client in Weldall und ein Schlüssel für Git-Anmeldungen), alle Konfigurationsvariablen, das Docker-Image `docker.io/seibertgroup/weldall-git-app` mit einem vollständigen `docker run`-Beispiel, die Datenbank und das Rotieren der Schlüssel. Was Weldall betrifft:

| Variable                                            | Bedeutung                                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GIT_APP_PUBLIC_ORIGIN`                             | Der öffentliche Origin der Git-App, zum Beispiel `https://git-app.example.com`, ohne Pfad und Schrägstrich. |
| `GIT_APP_RESOURCE_IDENTIFIER`                       | Der in Weldall registrierte Resource identifier. Standard: `<origin>/api`.                                  |
| `GIT_APP_DOWNSTREAM_CLIENT_ID`                      | Die Downstream client ID der Resource in Weldall, zum Beispiel `weldall-cli-at-git-app`.                    |
| `WELDALL_ISSUER`                                    | Der Origin von Weldall, zum Beispiel `https://weldall.example.com`.                                         |
| `WELDALL_MACHINE_CLIENT_ID`                         | Die Client-ID des Machine-Clients der Git-App in Weldall, zum Beispiel `git-app-machine`.                   |
| `WELDALL_MACHINE_KID`, `WELDALL_MACHINE_PUBLIC_JWK` | Key-ID und öffentlicher JWK des Machine-Schlüssels, eingetragen an diesem Machine-Client.                   |
| `GIT_APP_PUBLISH_SCOPE`, `GIT_APP_ADMIN_SCOPE`      | Standard `git-app:publish` und `git-app:admin`. Behalte die Standardwerte, siehe Hinweis unten.             |

:::note[Behalte die Standardnamen der Scopes]
Die Weldall-CLI erkennt eine Git-App an den Scopes `git-app:publish` und `git-app:admin`. Mit anderen Scope-Namen finden `weldall app publish` und die übrigen `weldall app`-Befehle die Git-App nicht. Mehrere Git-Apps teilen sich dieselben Scopes.
:::

## 2. Git-App in Weldall registrieren

Öffne die Administrationsoberfläche deiner Weldall-Instanz.

### Scopes anlegen

Lege unter **Scopes** an:

| Scope-Schlüssel         | Erlaubt                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `git-app:publish`       | Apps veröffentlichen, abgleichen, ihren Stand lesen sowie die eigenen Apps auflisten und bestätigen                    |
| `git-app:admin`         | Die [Checkliste](#3-checkliste-ausführen) ausführen, alle Apps sehen und ein bestehendes Repository registrieren       |
| `git-app:registry-read` | Machine-Clients eigener Werkzeuge [lesen die App-Registry](../app-registry/#die-registry-aus-eigenen-werkzeugen-lesen) |

Eine zweite Git-App nutzt dieselben Scopes.

### Resource registrieren

Lege unter **Resources** eine Resource an:

| Feld                 | Wert                                                        |
| -------------------- | ----------------------------------------------------------- |
| Resource key         | `git-app`                                                   |
| Name                 | `Git app (GitHub)`                                          |
| Resource identifier  | `https://git-app.example.com/api`                           |
| Authorization server | `https://git-app.example.com`                               |
| Downstream client ID | `weldall-cli-at-git-app`                                    |
| Request prefixes     | `https://git-app.example.com/api`                           |
| Scopes               | `git-app:publish`, `git-app:admin`, `git-app:registry-read` |
| Enabled              | an                                                          |
| Discover skills      | an                                                          |

Die Werte müssen zur Konfiguration der Git-App passen. Der Authorization Server ist der reine Origin aus `GIT_APP_PUBLIC_ORIGIN`; eine Git-App, deren Authorization Server einen Pfad hat, nimmt die CLI nicht an. Den Resource key geben Mitarbeitende als `--git-app` an, wenn es mehrere Git-Apps gibt, und er steht vor den Skills der Git-App.

Mit **Discover skills** zeigt Weldall die Skills der Git-App im Katalog:

- `git-app.publish-app` zeigt Agenten, wie sie veröffentlichen, abgleichen, den Stand lesen und die eigenen Apps auflisten und bestätigen. Alle sehen ihn, damit ein Agent den fehlenden Scope nennen kann.
- `git-app.admin-checklist` zeigt dem Agenten eines Administrators, wie er die Checkliste ausführt. Nur mit `git-app:admin` sichtbar.
- `git-app.admin-apps` zeigt dem Agenten eines Administrators, wie er die [App-Registry](../app-registry/) liest und ein bestehendes Repository registriert. Nur mit `git-app:admin` sichtbar.

### Machine-Client registrieren

Die Git-App spricht mit Weldall über einen eigenen Machine-Client. Wähle unter **Machine clients** die Option **Register machine** und trage die Client-ID aus `WELDALL_MACHINE_CLIENT_ID`, den öffentlichen Machine-JWK und seine Key-ID ein. Wähle unter **Machine access**:

- **Resources:** die eigene Resource der Git-App, `git-app`.
- **Scopes:** `weldall:app-host` und `weldall:subject-scopes-check`.

Mit `weldall:app-host` meldet die Git-App Audit-Ereignisse, immer nur für ihre eigene Resource. Mit `weldall:subject-scopes-check` fragt sie bei jeder Anfrage, ob die Person Weldall noch nutzen darf und `git-app:publish` noch hat; `weldall:login` steht nicht in der Resource der Git-App, und es abzufragen braucht zusätzlich `weldall:app-host`. Siehe [Machine-Authentifizierung](../machine-authentication/).

### Scopes zuweisen

Weise den Mitarbeitenden, die Apps veröffentlichen, `weldall:login` und `git-app:publish` zu, zum Beispiel über eine Gruppenzuweisung. Weise `git-app:admin` den Administratoren zu, die die Checkliste ausführen und die App-Registry prüfen.

### Oder per IaC beschreiben

Scopes, Resource, Machine-Client und Zuweisungen lassen sich auch per [Infrastructure as Code](../infrastructure-as-code/) beschreiben. Die Secrets der Git-App gehören nie dorthin:

```yaml
scopes:
  git_app_publish:
    key: git-app:publish
    description: Apps veröffentlichen
  git_app_admin:
    key: git-app:admin
    description: Checkliste der Git-App ausführen und alle Apps sehen
  git_app_registry_read:
    key: git-app:registry-read
    description: App-Registry lesen

resources:
  git_app:
    key: git-app
    name: Git app (GitHub)
    resourceIdentifier: https://git-app.example.com/api
    authorizationServer: https://git-app.example.com
    downstreamClientId: weldall-cli-at-git-app
    enabled: true
    skillDiscoveryEnabled: true
    requestPrefixes:
      - https://git-app.example.com/api
    scopes:
      - git-app:publish
      - git-app:admin
      - git-app:registry-read

machines:
  git_app:
    clientId: git-app-machine
    name: Git app (GitHub)
    enabled: true
    publicKeys:
      git-app-machine-1: { kty: EC, crv: P-256, x: "…", y: "…" }
    resources:
      - git-app
    scopes:
      - weldall:app-host
      - weldall:subject-scopes-check
```

## 3. Checkliste ausführen

Melde dich als Administrator mit `git-app:admin` per `weldall login` an und führe aus:

```sh
weldall app checklist
```

Die Git-App fragt ihren Git-Host nach ihrem Zugang, der Organisation, den Templates, dem Reviewer-Team, der Regel für den Default-Branch und der Commit-Identität. Sie liest nur. Jede Prüfung ist bestanden, fehlgeschlagen oder nicht prüfbar, jeweils mit Grund und nächstem Schritt. Schlägt eine Pflichtprüfung fehl, endet der Befehl mit Exit-Code `3`; mit `--json` gibt er den Bericht für Skripte aus. Weldall protokolliert jeden Lauf als `git_host.checked` im Audit-Log, weil er das Secret des Git-Hosts nutzt.

Manche Prüfungen brauchen ein bestehendes Repository, etwa das Schreibrecht des Reviewer-Teams und die Regel für den Default-Branch. Vor der ersten App lassen sie sich nicht prüfen. Nenne nach der ersten Veröffentlichung eine veröffentlichte App aus der [App-Registry](../app-registry/) (`weldall app list` zeigt ihre ID):

```sh
weldall app checklist --app <app-id>
```

Zeigt Weldall dir mehrere Git-Apps, ergänze `--git-app <resource key>`.

## Mehrere Git-Apps

Betreibe eine Git-App pro Git-Host, zum Beispiel eine für GitHub und eine für Forgejo, jede mit eigenem Origin, eigener Resource, eigenem Machine-Client und eigenen Schlüsseln. Darf eine Mitarbeitende in mehrere veröffentlichen, hält die erste Veröffentlichung einer App an und listet die Git-Apps auf. Sie wählt mit `--git-app <resource key>`, und der Ordner der App merkt sich die Wahl.

Die CLI schickt einen Token oder eine Git-Anmeldung nur an den Origin, den Weldall für diesen Resource key nennt. Änderst du den Origin einer Git-App später in Weldall, lehnt die CLI App-Ordner ab, die noch auf die alte Adresse zeigen, und nennt die neue.

## Host-Secret rotieren

1. Erzeuge das neue Secret auf dem Git-Host: einen neuen privaten Schlüssel der GitHub App oder einen neuen Access Token des Forgejo-Bot-Benutzers mit denselben Scopes. GitHub und Forgejo lassen das alte gültig, bis du es löschst.
2. Ersetze die Secret-Datei der Git-App und starte sie neu, während niemand veröffentlicht.
3. Führe `weldall app checklist` aus.
4. Lösche den alten Schlüssel oder Token auf dem Git-Host.

Die übrigen Schlüssel der Git-App (ihr Signaturschlüssel, ihr Machine-Schlüssel und der Schlüssel für Git-Anmeldungen) rotierst du, wie es ihre [README](https://github.com/seibert-external/weldall-git-app#readme) beschreibt. Eine Git-Anmeldung gilt fünf Minuten und lässt sich nicht einzeln widerrufen. Deshalb fragt die Git-App bei jeder Git-Anfrage erneut bei Weldall, ob die Person noch veröffentlichen darf: Wer `git-app:publish` verliert, wird bei der nächsten Anfrage abgewiesen.

:::caution[Stand]
Die Git-App ist gegen nachgebildete GitHub- und Forgejo-APIs und ein nachgebildetes Weldall getestet, ihr Git-Proxy gegen einen echten Git-Server und ihre Registry gegen ein echtes PostgreSQL. Was noch nicht geprüft ist, steht in der [README](https://github.com/seibert-external/weldall-git-app#not-built-yet) der Git-App.
:::
