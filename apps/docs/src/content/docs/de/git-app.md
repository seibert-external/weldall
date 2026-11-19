---
title: "How to: Git-App betreiben"
description: Die Git-App betreiben, die die Repositorys veröffentlichter Apps auf deinem GitHub oder Forgejo verwaltet, und sie in Weldall registrieren.
sidebar:
  label: "How to: Git-App betreiben"
---

Mitarbeitende [veröffentlichen Apps](../publish-apps/), die sie mit einem Agenten gebaut haben, auf dem Git-Host deiner Organisation. Die Arbeit auf dem Git-Host erledigt die **Git-App**: Sie legt die Repositorys an, stellt Git für sie bereit und öffnet die Pull Requests. Sie ist ein eigener Dienst, den deine Organisation neben Weldall betreibt, eine Instanz pro Git-Host, und den du in Weldall als [Resource](../service-configuration/) registrierst.

So sind die Aufgaben verteilt:

- **Die Git-App** verwahrt das Secret des Git-Hosts (den privaten Schlüssel der GitHub App oder den Access Token des Forgejo-Bot-Benutzers). Das Secret verlässt sie nie.
- **Weldall** entscheidet, wer veröffentlichen darf, führt die [App-Registry](../app-registry/) und speichert das Audit-Log. Die Git-App fragt Weldall bei jeder Anfrage und meldet jedes angelegte Repository, jeden Push und Abruf, jeden Pull Request und jede Git-Anmeldung.

Diese Anleitung richtet sich an die Administratoren, die die Git-App betreiben und in Weldall registrieren. Die Schritte für den jeweiligen Host stehen in [How to: GitHub anbinden](../github-app/) und [How to: Forgejo anbinden](../forgejo/).

## Voraussetzungen

- Ein laufendes Weldall und Administratorzugriff darauf.
- Ein öffentlicher HTTPS-Origin für die Git-App, zum Beispiel `https://git-app.example.com`. Die Git-App muss an der Wurzel dieses Origins erreichbar sein, nicht unter einem Pfad. Terminiere TLS vor dem Container.
- Den Git-Host, vorbereitet wie in [How to: GitHub anbinden](../github-app/) oder [How to: Forgejo anbinden](../forgejo/) beschrieben. Von dort bringst du die Host-Konfiguration und das Host-Secret mit.

Die Geräte der Mitarbeitenden erreichen die Git-App über HTTPS. Die Git-App erreicht Weldall und den Git-Host, und Weldall erreicht die Git-App, um ihre Skills zu finden.

## 1. Schlüssel erzeugen

Die Git-App braucht zwei ES256-Schlüsselpaare und einen Zufallsschlüssel:

- einen **Signaturschlüssel** für die Access Tokens, die ihr eigener Authorization Server ausstellt,
- einen **Machine-Schlüssel** für ihren Machine-Client in Weldall,
- einen **Git-Anmeldungsschlüssel**, der die kurzlebigen Git-Anmeldungen signiert.

Der Generator braucht nur Node.js:

```sh
docker run --rm node:24-slim node -e '
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const jwk = (key) => JSON.stringify(key.export({ format: "jwk" }));
const signing = generateKeyPairSync("ec", { namedCurve: "P-256" });
const machine = generateKeyPairSync("ec", { namedCurve: "P-256" });
console.log("GIT_APP_SIGNING_KID=git-app-signing-1");
console.log(`GIT_APP_SIGNING_PUBLIC_JWK=${jwk(signing.publicKey)}`);
console.log(`GIT_APP_SIGNING_PRIVATE_JWK=${jwk(signing.privateKey)}`);
console.log("WELDALL_MACHINE_KID=git-app-machine-1");
console.log(`WELDALL_MACHINE_PUBLIC_JWK=${jwk(machine.publicKey)}`);
console.log(`WELDALL_MACHINE_PRIVATE_JWK=${jwk(machine.privateKey)}`);
console.log(`GIT_APP_GIT_CREDENTIAL_KEY=${randomBytes(32).toString("base64")}`);'
```

Lege die Ausgabe in deinem Secret-Manager ab. Die privaten JWKs und der Git-Anmeldungsschlüssel sind Secrets, die öffentlichen JWKs und Key-IDs nicht.

## 2. Git-App konfigurieren

Die Git-App liest ihre Konfiguration aus der Umgebung. Jedes Secret kommt entweder aus einer Variablen oder aus einer Datei, deren Pfad in `<NAME>_FILE` steht, nie aus beidem. Nimm bevorzugt Dateien, die aus deinem Secret-Manager eingebunden werden.

| Variable                                              | Pflicht | Bedeutung                                                                                                                                    |
| ----------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GIT_APP_HOST`                                        | ja      | `github` oder `forgejo`.                                                                                                                     |
| `GIT_APP_HOST_CONFIG` oder `GIT_APP_HOST_CONFIG_FILE` | ja      | Die Host-Konfiguration als JSON, siehe [GitHub](../github-app/#5-git-app-konfigurieren) oder [Forgejo](../forgejo/#7-git-app-konfigurieren). |
| `GIT_APP_HOST_SECRET` oder `GIT_APP_HOST_SECRET_FILE` | ja      | Secret: der private Schlüssel der GitHub App oder der Access Token des Forgejo-Bot-Benutzers.                                                |
| `GIT_APP_PUBLIC_ORIGIN`                               | ja      | Der öffentliche Origin der Git-App, zum Beispiel `https://git-app.example.com`, ohne Pfad und ohne Schrägstrich am Ende.                     |
| `GIT_APP_RESOURCE_IDENTIFIER`                         | nein    | Der in Weldall registrierte Resource Identifier. Standard: `<origin>/api`.                                                                   |
| `GIT_APP_DOWNSTREAM_CLIENT_ID`                        | ja      | Die Downstream-Client-ID, die an der Resource in Weldall eingetragen ist, zum Beispiel `weldall-cli-at-git-app`.                             |
| `GIT_APP_SIGNING_KID`, `GIT_APP_SIGNING_PUBLIC_JWK`   | ja      | Key-ID und öffentlicher JWK des Signaturschlüssels.                                                                                          |
| `GIT_APP_SIGNING_PRIVATE_JWK` oder `..._FILE`         | ja      | Secret: der private JWK des Signaturschlüssels.                                                                                              |
| `GIT_APP_GIT_CREDENTIAL_KEY` oder `..._FILE`          | ja      | Secret: der Git-Anmeldungsschlüssel, Base64 von mindestens 32 Zufallsbytes.                                                                  |
| `GIT_APP_GIT_CREDENTIAL_PREVIOUS_KEY` oder `..._FILE` | nein    | Secret: der vorige Git-Anmeldungsschlüssel während einer [Rotation](#git-anmeldungsschlüssel-rotieren).                                      |
| `GIT_APP_PUBLISH_SCOPE`                               | nein    | Standard `git-app:publish`. Behalte den Standard, siehe Hinweis unten.                                                                       |
| `GIT_APP_ADMIN_SCOPE`                                 | nein    | Standard `git-app:admin`. Behalte den Standard, siehe Hinweis unten.                                                                         |
| `WELDALL_ISSUER`                                      | ja      | Der Origin von Weldall, zum Beispiel `https://weldall.example.com`.                                                                          |
| `WELDALL_MACHINE_CLIENT_ID`                           | ja      | Die Client-ID des Machine-Clients der Git-App in Weldall, zum Beispiel `git-app-machine`.                                                    |
| `WELDALL_MACHINE_KID`, `WELDALL_MACHINE_PUBLIC_JWK`   | ja      | Key-ID und öffentlicher JWK des Machine-Schlüssels.                                                                                          |
| `WELDALL_MACHINE_PRIVATE_JWK` oder `..._FILE`         | ja      | Secret: der private JWK des Machine-Schlüssels.                                                                                              |
| `PORT`                                                | nein    | Standard `3002`.                                                                                                                             |

Fehlt etwas in der Konfiguration oder ist es ungültig, startet die Git-App nicht. Sie nennt jedes Problem mit dem Namen der Variablen und gibt nie einen Wert aus.

:::note[Behalte die Standardnamen der Scopes]
Die Weldall CLI erkennt eine Git-App an den Scopes `git-app:publish` und `git-app:admin`. Mit anderen Scope-Namen finden `weldall app publish` und die übrigen `weldall app`-Befehle die Git-App nicht. Mehrere Git-Apps teilen sich dieselben beiden Scopes.
:::

## 3. Container starten

Das Image ist `docker.io/seibertgroup/weldall-git-app`, siehe [Docker-Images](../docker/). Starte einen Container pro Git-Host:

```sh
docker run -d --name weldall-git-app -p 3002:3002 \
  -e GIT_APP_HOST=github \
  -e GIT_APP_HOST_CONFIG_FILE=/run/secrets/host.json \
  -e GIT_APP_HOST_SECRET_FILE=/run/secrets/github-app.pem \
  -e GIT_APP_PUBLIC_ORIGIN=https://git-app.example.com \
  -e GIT_APP_DOWNSTREAM_CLIENT_ID=weldall-cli-at-git-app \
  -e GIT_APP_SIGNING_KID=git-app-signing-1 \
  -e GIT_APP_SIGNING_PUBLIC_JWK='{"kty":"EC","crv":"P-256","x":"…","y":"…"}' \
  -e GIT_APP_SIGNING_PRIVATE_JWK_FILE=/run/secrets/signing.jwk \
  -e GIT_APP_GIT_CREDENTIAL_KEY_FILE=/run/secrets/git-credential.key \
  -e WELDALL_ISSUER=https://weldall.example.com \
  -e WELDALL_MACHINE_CLIENT_ID=git-app-machine \
  -e WELDALL_MACHINE_KID=git-app-machine-1 \
  -e WELDALL_MACHINE_PUBLIC_JWK='{"kty":"EC","crv":"P-256","x":"…","y":"…"}' \
  -e WELDALL_MACHINE_PRIVATE_JWK_FILE=/run/secrets/machine.jwk \
  -v /srv/git-app/secrets:/run/secrets:ro \
  docker.io/seibertgroup/weldall-git-app:X.Y.Z
```

- Der Container lauscht mit einfachem HTTP auf `PORT` und beantwortet `GET /health` mit `{ "status": "ok" }`.
- Er läuft als Benutzer ohne Sonderrechte mit UID 1000. Die eingebundenen Dateien müssen für diesen Benutzer lesbar sein.
- **Betreibe genau einen Container pro Git-App.** Die Git-App hält ihren Replay-Schutz und ihre Grenzen für Übertragungen und Git-Anmeldungen im Speicher ihres Prozesses; ein zweiter Container sähe sie nicht.
- **Stop-Wartezeit.** Bei `SIGTERM` nimmt die Git-App keine Anfragen mehr an und gibt laufenden höchstens 8 Sekunden. Stelle die Stop-Wartezeit deiner Plattform auf 10 Sekunden oder mehr (`docker stop --time`, Compose `stop_grace_period`, Kubernetes `terminationGracePeriodSeconds`). Ein Push oder Abruf, der länger dauert, wird abgebrochen und schlägt auf dem Rechner der Mitarbeitenden fehl. Starte oder aktualisiere die Git-App deshalb, während niemand veröffentlicht.

## 4. Git-App in Weldall registrieren

Öffne die Administrationsoberfläche deiner Weldall-Instanz.

### Scopes anlegen

Lege unter **Scopes** an:

| Scope-Schlüssel   | Erlaubt                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `git-app:publish` | Apps veröffentlichen, abgleichen und ihren Stand lesen            |
| `git-app:admin`   | Die [Checkliste](#5-checkliste-ausführen) einer Git-App ausführen |

Eine zweite Git-App nutzt dieselben beiden Scopes.

### Resource registrieren

Lege unter **Resources** eine Resource an:

| Feld                 | Wert                               |
| -------------------- | ---------------------------------- |
| Resource key         | `git-app`                          |
| Name                 | `Git app (GitHub)`                 |
| Resource identifier  | `https://git-app.example.com/api`  |
| Authorization server | `https://git-app.example.com`      |
| Downstream client ID | `weldall-cli-at-git-app`           |
| Request prefixes     | `https://git-app.example.com/api`  |
| Scopes               | `git-app:publish`, `git-app:admin` |
| Enabled              | an                                 |
| Discover skills      | an                                 |

Die Werte müssen zur Konfiguration der Git-App passen. Der Authorization Server ist der reine Origin aus `GIT_APP_PUBLIC_ORIGIN`; eine Git-App, deren Authorization Server einen Pfad hat, nimmt die CLI nicht an. Den Resource key geben Mitarbeitende als `--git-app` an, wenn es mehrere Git-Apps gibt, und er steht vor den Skills der Git-App.

Mit **Discover skills** zeigt Weldall zwei Skills der Git-App im Katalog:

- `git-app.publish-app` zeigt Agenten, wie sie veröffentlichen, abgleichen und den Stand lesen. Alle sehen ihn, damit ein Agent den fehlenden Scope nennen kann.
- `git-app.admin-checklist` zeigt dem Agenten eines Administrators, wie er die Checkliste ausführt. Nur mit `git-app:admin` sichtbar.

Sobald für die Resource Apps registriert sind, lässt Weldall sie nicht mehr löschen.

### Machine-Client registrieren

Die Git-App spricht mit Weldall über einen eigenen Machine-Client. Wähle unter **Machine clients** die Option **Register machine** und trage die Client-ID aus `WELDALL_MACHINE_CLIENT_ID`, den öffentlichen Machine-JWK und seine Key-ID ein. Wähle unter **Machine access**:

- **Resources:** die eigene Resource der Git-App, `git-app`.
- **Scopes:** `weldall:app-host` und `weldall:subject-scopes-check`.

Mit `weldall:app-host` registriert die Git-App Apps, aktualisiert ihre Links und meldet Audit-Ereignisse, immer nur für die Apps ihrer eigenen Resource. Mit `weldall:subject-scopes-check` fragt sie bei jeder Anfrage, ob die Person Weldall noch nutzen darf und `git-app:publish` noch hat. Siehe [Machine-Authentifizierung](../machine-authentication/).

### Scopes zuweisen

Weise den Mitarbeitenden, die Apps veröffentlichen, `weldall:login` und `git-app:publish` zu, zum Beispiel über eine Gruppenzuweisung. Weise `git-app:admin` den Administratoren zu, die die Checkliste ausführen.

### Oder per IaC beschreiben

Scopes, Resource, Machine-Client und Zuweisungen lassen sich auch per [Infrastructure as Code](../infrastructure-as-code/) beschreiben. Die Secrets der Git-App gehören nie dorthin:

```yaml
scopes:
  git_app_publish:
    key: git-app:publish
    description: Apps veröffentlichen
  git_app_admin:
    key: git-app:admin
    description: Checkliste der Git-App ausführen

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

## 5. Checkliste ausführen

Melde dich als Administrator mit `git-app:admin` per `weldall login` an und führe aus:

```sh
weldall app checklist
```

Die Git-App fragt ihren Git-Host nach ihrem Zugang, der Organisation, den Templates, dem Reviewer-Team, der Regel für den Default-Branch und der Commit-Identität. Sie liest nur. Jede Prüfung ist bestanden, fehlgeschlagen oder nicht prüfbar, jeweils mit Grund und nächstem Schritt. Schlägt eine Pflichtprüfung fehl, endet der Befehl mit Exit-Code `3`; mit `--json` gibt er den Bericht für Skripte aus. Weldall protokolliert jeden Lauf als `git_host.checked` im Audit-Log, weil er das Secret des Git-Hosts nutzt.

Manche Prüfungen brauchen ein bestehendes Repository, etwa das Schreibrecht des Reviewer-Teams und die Regel für den Default-Branch. Vor der ersten App lassen sie sich nicht prüfen. Nenne nach der ersten Veröffentlichung eine veröffentlichte App aus der [App-Registry](../app-registry/):

```sh
weldall app checklist --app <app-id>
```

Zeigt Weldall dir mehrere Git-Apps, ergänze `--git-app <resource key>`.

## Mehrere Git-Apps

Betreibe eine Git-App pro Git-Host, zum Beispiel eine für GitHub und eine für Forgejo, jede mit eigenem Origin, eigener Resource, eigenem Machine-Client und eigenen Schlüsseln. Darf eine Mitarbeiterin in mehrere veröffentlichen, hält die erste Veröffentlichung einer App an und listet die Git-Apps auf. Sie wählt mit `--git-app <resource key>`, und der Ordner der App merkt sich die Wahl.

Die CLI schickt einen Token oder eine Git-Anmeldung nur an den Origin, den Weldall für diesen Resource key nennt. Änderst du den Origin einer Git-App später in Weldall, lehnt die CLI App-Ordner ab, die noch auf die alte Adresse zeigen, und nennt die neue.

## Host-Secret rotieren

1. Erzeuge das neue Secret auf dem Git-Host: einen neuen privaten Schlüssel der GitHub App oder einen neuen Access Token des Forgejo-Bot-Benutzers mit denselben Scopes. GitHub und Forgejo lassen das alte gültig, bis du es löschst.
2. Ersetze die Secret-Datei der Git-App und starte sie neu, während niemand veröffentlicht.
3. Führe `weldall app checklist` aus.
4. Lösche den alten Schlüssel oder Token auf dem Git-Host.

## Git-Anmeldungsschlüssel rotieren

Eine Git-Anmeldung gilt fünf Minuten. Die Git-App prüft sie gegen den aktuellen und, falls gesetzt, den vorigen Schlüssel:

1. Erzeuge einen neuen Schlüssel, zum Beispiel mit `openssl rand -base64 32`.
2. Setze den neuen Schlüssel als `GIT_APP_GIT_CREDENTIAL_KEY` und den alten als `GIT_APP_GIT_CREDENTIAL_PREVIOUS_KEY` und starte die Git-App neu.
3. Entferne nach fünf Minuten `GIT_APP_GIT_CREDENTIAL_PREVIOUS_KEY` und starte erneut.

Ersetzt du den Schlüssel ohne den vorigen, werden alle Git-Anmeldungen ungültig, die er signiert hat. Einen anderen Weg, eine einzelne Git-Anmeldung zu widerrufen, gibt es nicht. Deshalb fragt die Git-App bei jeder Git-Anfrage erneut bei Weldall, ob die Person noch veröffentlichen darf: Wer `git-app:publish` verliert, wird bei der nächsten Anfrage abgewiesen.

:::caution[Stand]
Die Git-App ist gegen nachgebildete GitHub- und Forgejo-APIs und ein nachgebildetes Weldall getestet, ihr Git-Proxy gegen einen echten Git-Server. Gegen ein echtes GitHub, Forgejo oder Weldall lief sie noch nicht, und ihr Image ist noch in keinem echten Betrieb geprüft.
:::
