---
title: "How to: Forgejo anbinden"
description: Einen Forgejo-Connector einrichten, damit Mitarbeitende über Weldall Apps in deiner Forgejo-Organisation veröffentlichen.
sidebar:
  label: "How to: Forgejo anbinden"
---

Diese Anleitung richtet sich an die Administratoren der Forgejo-Instanz und der Organisation, in der die veröffentlichten Apps landen, und an die Weldall-Administratoren, die den Connector konfigurieren. Veröffentlichen funktioniert wie in [Apps auf GitHub veröffentlichen](../connectors/#apps-auf-github-veröffentlichen) beschrieben; was anders ist, steht unter [Forgejo](../connectors/#forgejo).

Du brauchst eine Person mit Administratorrechten auf der Instanz oder Owner-Rechten in der Forgejo-Organisation, mindestens ein Template-Repository und einen Weldall-IaC-Workspace (siehe [Infrastructure as Code](../infrastructure-as-code/)). Gebaut und getestet ist der Connector gegen Forgejo 17.

## Wie Weldall Forgejo erreicht

Forgejo kennt nichts wie eine GitHub App mit kurzlebigen Installations-Tokens. Weldall handelt als eigener **Bot-Benutzer** und nutzt für alles einen Access Token dieses Benutzers: Repositorys anlegen, Git-Proxy, Pull Requests und Statusabfragen. Der Token bleibt auf dem Weldall-Server und gelangt nie auf den Rechner einer Mitarbeiterin.

:::caution[Der Bot-Token ist langlebig und weitreichend]
Access Tokens von Forgejo laufen nicht ab, und ihre Scopes lassen sich für das, was Weldall braucht, nicht pro Repository einschränken: Tokens für einzelne Repositorys können keine Repositorys anlegen, und Tokens erzeugen kann nur der Benutzer selbst mit seinem Passwort oder ein Instanz-Administrator. Weldall kann deshalb nicht wie bei GitHub pro Anfrage einen engen Token holen. Wer den Token bekommt, kann als Bot-Benutzer auf jedes Repository zugreifen, das der Bot-Benutzer erreicht, bis jemand den Token in Forgejo widerruft. Halte diese Reichweite klein: eine eigene Organisation, ein Bot-Benutzer, der weder Instanz-Administrator noch Owner der Organisation ist, und die Scopes unten. Weldall senkt seinen eigenen Zugriff auf jedes neue Repository gleich nach dem Anlegen auf Schreibzugriff.
:::

## 1. Organisation vorbereiten

Nimm eine Organisation, die nur veröffentlichte Apps und ihre Templates enthält, zum Beispiel `example-org`. Das Reviewer-Team braucht Zugriff auf alle ihre Repositorys (Schritt 4), und Forgejo kennt keine Branch-Regeln für die ganze Organisation. Eine eigene Organisation hält beides auf Apps begrenzt.

## 2. Bot-Benutzer anlegen

Lege als Instanz-Administrator einen Benutzer für Weldall an, zum Beispiel `weldall-bot`:

- Er darf **kein** Instanz-Administrator sein.
- Gib ihm eine primäre E-Mail-Adresse. Weldall nutzt Namen und Adresse des Benutzers für die Commits, die es pusht, und Forgejo ordnet Commits über die Adresse zu.
- Mach ihn nicht zum Owner der Organisation und nimm ihn in kein Team mit Admin-Zugriff auf. Sonst schlägt `weldall connectors check` fehl.

## 3. Dem Bot-Benutzer das Anlegen erlauben

Lege in der Organisation ein Team an, zum Beispiel `weldall-publishers`:

- **Berechtigung**: Lesen. **Repositorys erstellen**: erlaubt. **Zugriff auf alle Repositorys**: aus.
- Der Bot-Benutzer ist das einzige Mitglied, und jedes Template-Repository gehört zum Team.

Forgejo macht den Ersteller eines neuen Organisations-Repositorys zu dessen Administrator. Weldall setzt seinen eigenen Zugriff auf das neue Repository sofort auf Schreiben. So kann der Bot-Benutzer weder den Branch-Schutz ändern noch das Repository öffentlich machen.

## 4. Reviewer-Team benennen

Lege ein Team an, zum Beispiel `app-reviewers`, mit den Reviewern als Mitgliedern:

- **Berechtigung**: Schreiben, mindestens für Code und Pull Requests, damit ihre Freigaben zählen.
- **Zugriff auf alle Repositorys**: an.

Forgejo fügt einem neuen Repository nur das Owners-Team hinzu, und der Bot-Benutzer von Weldall darf keine Teams hinzufügen. „Zugriff auf alle Repositorys“ ist der einzige Weg, auf dem das Reviewer-Team neue Repositorys ohne Zutun eines Owners erreicht. Weldall fordert bei jedem Pull Request ein Review von diesem Team an und stoppt das erste Publish mit einer Meldung für die Administratoren, wenn das Team keinen Schreibzugriff hat.

## 5. Templates vorbereiten

Für jedes Template-Repository:

- In den **Einstellungen** **Template** ankreuzen.
- Eine **Branch-Schutzregel** für den Default-Branch anlegen: Push aus, mindestens eine nötige Freigabe, **Auch für Administratoren** an. Wir empfehlen zusätzlich, veraltete Freigaben zu verwerfen und Merges bei abgelehnten Reviews zu sperren.

Weldall legt jedes Repository mit der Option „Branch-Schutzregeln übernehmen“ von Forgejo an. So startet jedes neue Repository mit der Regel seines Templates. Regeln für die ganze Organisation gibt es in Forgejo nicht, das Template ist also der einzige Ort dafür. Geschützte Default-Branches lassen sich weder per Force-Push überschreiben noch löschen.

## 6. Access Token erzeugen

Öffne als Bot-Benutzer **Einstellungen → Anwendungen → Access Tokens** und erzeuge einen Token mit:

| Scope                | Wofür Weldall ihn braucht                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `write:repository`   | Über den Git-Proxy pushen und abrufen, Pull Requests öffnen, Reviews und Status lesen      |
| `write:organization` | Repositorys in der Organisation anlegen (mit `read:organization` lehnt Forgejo das ab)     |
| `read:user`          | Name und E-Mail des Bot-Benutzers für Commits lesen und die eigenen Scopes für die Prüfung |

Beschränke den Token nicht auf einzelne Repositorys: Ein solcher Token kann keine Repositorys anlegen. Gib keine weiteren Scopes; die Prüfung meldet sie. Übergib den Token den Weldall-Administratoren nur über den Secret-Tresor deiner Organisation, oder füge ihn in Schritt 8 selbst ein.

## 7. Connector konfigurieren

Lege den Connector, den Scope fürs Veröffentlichen und eine geteilte Verbindung für den Token an, beide deaktiviert:

```yaml
scopes:
  apps_publish:
    key: apps:publish
    description: Apps auf Forgejo veröffentlichen

connectors:
  forgejo:
    key: forgejo
    name: Forgejo
    type: forgejo
    enabled: false
    envelopeProvider: LOCAL_ENV
    requiredScopes:
      - apps:publish
    provider:
      baseUrl: https://forgejo.example.com
      organization: example-org
      botUser: weldall-bot
      templates:
        - name: react
          repository: example-org/react-app-template
      repositoryNamePrefix: app-
      reviewerTeam: app-reviewers
      setupMode: customer-managed
      previewStatusContext: weldall/preview
      liveStatusContext: weldall/live

sharedConnections:
  forgejo_token:
    key: forgejo-bot-token
    connectorKey: forgejo
    name: Forgejo bot token
    enabled: false
    useScopes:
      - apps:publish
    credentialManagerEmail: admin@example.com
    serviceAccountLabel: weldall-bot
    provider:
      kind: forgejo-bot-token
```

| Feld                   | Bedeutung                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`              | Die https-Adresse der Forgejo-Instanz, mit Unterpfad, falls Forgejo unter einem läuft, ohne Schrägstrich am Ende. Ein DNS-Name auf dem Standard-Port; IP-Adressen, Ports, Zugangsdaten und lokale Namen werden abgelehnt. |
| `organization`         | Die Organisation, in der die Repositorys entstehen.                                                                                                                                                                       |
| `botUser`              | Der Bot-Benutzer aus Schritt 2. Weldall prüft, dass der Token ihm gehört.                                                                                                                                                 |
| `templates`            | Bis zu 50 Templates. `name` wählen Mitarbeitende und Agenten; `repository` ist `owner/name`.                                                                                                                              |
| `repositoryNamePrefix` | Wird jedem neuen Repository-Namen vorangestellt, zum Beispiel `app-expenses`. Darf leer sein.                                                                                                                             |
| `reviewerTeam`         | Der Name des Reviewer-Teams aus Schritt 4.                                                                                                                                                                                |
| `setupMode`            | `customer-managed`: Die Templates bringen den Branch-Schutz mit, das Reviewer-Team hat Zugriff auf alle Repositorys, und deine Organisation stellt die CI-Secrets. Eine andere Betriebsart gibt es für Forgejo nicht.     |
| `previewStatusContext` | Kontext des Commit-Status, dessen Ziel-URL am Kopf-Commit des Pull Requests der Vorschau-Link der App ist. Standard `weldall/preview`.                                                                                    |
| `liveStatusContext`    | Kontext des Commit-Status, dessen Ziel-URL am Default-Branch der Live-Link der App ist. Standard `weldall/live`.                                                                                                          |

Forgejo kennt keine Deployments. Die CI des Templates meldet ihre Links deshalb als Commit-Status mit diesen Kontexten, dem Zustand `success` und einer https-Ziel-URL.

Weldall schickt den Bot-Token nur an `baseUrl`, folgt keinen Weiterleitungen und prüft das TLS-Zertifikat des Servers. Die Adresse darf in dein internes Netz zeigen: Welche Forgejo-Instanz den Token bekommt, entscheiden die Weldall-Administratoren beim Konfigurieren des Connectors. Nutzt die Instanz ein Zertifikat einer internen Zertifizierungsstelle, muss der Weldall-Server dieser vertrauen (zum Beispiel über `NODE_EXTRA_CA_CERTS`).

Mitarbeitende brauchen zum Veröffentlichen jeden Scope aus `requiredScopes` des Connectors. Führe `weldall plan` aus, prüfe den Plan und dann `weldall up`.

## 8. Token einfügen und Connector aktivieren

Öffne in der Weldall-Admin-Oberfläche **Admin → Connections**, wähle die geteilte Verbindung und füge den Token unter **Provision access token** ein. Weldall bindet ihn an die konfigurierte Instanz und den Bot-Benutzer und speichert ihn verschlüsselt, wie alle Connector-Zugangsdaten. Das Einfügen aktiviert nichts: Setze `enabled: true` am Connector und an der geteilten Verbindung im Manifest und wende es erneut an.

## 9. Einrichtung prüfen

Führe als Weldall-Administrator aus:

```sh
weldall connectors check forgejo
```

Der Befehl liest nur. Er prüft, dass Forgejo den Token annimmt und dass er dem Bot-Benutzer gehört, dass der Bot-Benutzer weder Instanz-Administrator noch Owner der Organisation ist und Repositorys anlegen darf, die Scopes des Tokens (und ob er mehr hat als nötig), jedes Template und seinen Branch-Schutz, das Reviewer-Team und seinen „Zugriff auf alle Repositorys“, die Commit-Identität und, sobald es eine App gibt, an deren Repository den Zugriff des Reviewer-Teams, den Schutz des Default-Branches und den Zugriff des Bot-Benutzers. Der Befehl endet mit Code `3`, wenn eine nötige Prüfung fehlschlägt.

## CI-Secrets und Workflows

Neue Repositorys bekommen die Dateien des Templates, aber nicht seine Secrets und Variablen.

:::danger[Forgejo führt Workflows aus, die auf einen Publish-Branch gepusht werden]
Das ist ein Unterschied zu GitHub. Dort wird ein Push, der eine Workflow-Datei ändert, abgelehnt, weil die App kein Workflows-Recht hat. Forgejo nimmt ihn an, und Forgejo Actions führt die Workflow-Definitionen des gepushten Branches aus. Publish übernimmt `.forgejo/workflows`, `.gitea/workflows` und `.github/workflows` immer aus dem Repository, damit Mitarbeitende sie nicht versehentlich ändern. Aber wer eine App veröffentlichen darf, kann von Hand über den Git-Proxy einen eigenen Workflow auf einen `weldall/publish-*`-Branch pushen. Dieser Workflow:

- läuft sofort, bevor jemand den Pull Request prüft;
- kann jedes Actions-Secret lesen, das das Repository erreicht: seine eigenen und die der Organisation, die Forgejo allen Repositorys der Organisation gibt ([Secrets](https://forgejo.org/docs/latest/user/actions/basic-concepts/#secrets));
- läuft auf den Runnern, die dem Repository zur Verfügung stehen, mit deren Netzwerkzugang;
- bekommt den automatischen Token des Laufs, der Schreibzugriff auf das Repository hat ([Automatic token](https://forgejo.org/docs/latest/user/actions/basic-concepts/#automatic-token)). Dieser Token geht direkt an Forgejo, die Regeln des Git-Proxys (nur `weldall/publish-*`-Branches, nie der Default-Branch) gelten für ihn nicht. Ob eine Branch-Schutzregel ihn dann am Default-Branch noch aufhält, ist nicht geprüft.

Die Forgejo-Doku beschreibt keinen Weg, ein Secret auf einen Branch oder eine Umgebung zu beschränken; Weldall hat keinen geprüft. Eine Branch-Schutzregel mit geschützten Dateimustern hilft auch nicht: Forgejo vergleicht einen neuen Branch mit einem leeren Stand und würde jedes Publish ablehnen.

Mach deshalb eines davon:

- **Actions ausschalten** für die Templates und jedes App-Repository (Einstellungen des Repositorys, Einheit **Actions**), und außerhalb von Forgejo Actions bauen und deployen. Ob ein Repository aus einem Template dessen Actions-Einstellung übernimmt, ist nicht geprüft; prüfe deshalb die App-Repositorys. `weldall connectors check` meldet die Templates und das neueste App-Repository, solange Actions dort an ist.
- Oder Zugangsdaten fürs Deployment nicht als Actions-Secrets ablegen, die App-Repositorys erreichen: außerhalb von Actions deployen oder die CI der App-Repositorys auf einem eigenen Runner in einer eigenen Organisation ohne Deployment-Secrets laufen lassen.
  :::

## Was geprüft ist

Der Connector lief gegen ein lokales Forgejo 17: privates Repository aus einem Template mit seinem Branch-Schutz anlegen, Zugriff des Bot-Benutzers auf Schreiben senken, einen Publish-Branch pushen, Ablehnung eines direkten Pushs auf den geschützten Default-Branch, Pull Request mit Reviewer-Team öffnen, Reviews, Commit-Status und Vorschau-Link lesen, die Commit-Identität und die vollständige Prüfung. Gegen eine produktive Forgejo-Instanz und über den Git-Proxy gegen ein echtes Forgejo lief er noch nicht; den Git-Proxy selbst prüfen Tests mit einem echten Git-Server.
