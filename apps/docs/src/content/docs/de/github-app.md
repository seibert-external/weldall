---
title: "How to: GitHub anbinden"
description: Einen GitHub-App-Connector einrichten, damit Mitarbeitende über Weldall Apps in deiner GitHub-Organisation veröffentlichen.
sidebar:
  label: "How to: GitHub anbinden"
---

Diese Anleitung richtet sich an die Administratoren der GitHub-Organisation, in der die veröffentlichten Apps landen, und an die Weldall-Administratoren, die den Connector konfigurieren. Was Veröffentlichen bewirkt und wie der Git-Proxy deine Repositorys schützt, beschreibt [Apps auf GitHub veröffentlichen](../connectors/#apps-auf-github-veröffentlichen).

Du brauchst eine Person mit Owner-Rechten in der GitHub-Organisation, mindestens ein Template-Repository in dieser Organisation und einen Weldall-IaC-Workspace (siehe [Infrastructure as Code](../infrastructure-as-code/)).

## 1. GitHub App anlegen

Öffne in GitHub die **Settings** der Organisation und dort **Developer settings → GitHub Apps → New GitHub App**:

- **GitHub App name** und **Homepage URL**: ein beliebiger Name und deine Weldall-URL.
- **Webhook**: Deaktiviere **Active**. Weldall empfängt keine Webhooks.
- **Where can this GitHub App be installed?**: **Only on this account**.

Vergib genau diese Berechtigungen:

| Bereich                  | Berechtigung        | Zugriff        | Wofür Weldall sie braucht                                                            |
| ------------------------ | ------------------- | -------------- | ------------------------------------------------------------------------------------ |
| Repository permissions   | Contents            | Read and write | Über den Git-Proxy holen und pushen, Templates lesen                                 |
| Repository permissions   | Metadata            | Read-only      | Repositorys, ihre Branches und die geltenden Regeln lesen (setzt GitHub automatisch) |
| Repository permissions   | Pull requests       | Read and write | Pull Requests öffnen, das Reviewer-Team anfragen, Reviews lesen                      |
| Repository permissions   | Checks              | Read-only      | Ergebnisse der Checks in `weldall app status` zeigen                                 |
| Repository permissions   | Commit statuses     | Read-only      | Commit-Status in `weldall app status` zeigen                                         |
| Repository permissions   | Deployments         | Read-only      | Die Vorschau- und Live-Links lesen, die die CI der App meldet                        |
| Organization permissions | Repository creation | Read and write | Repositorys aus Templates anlegen                                                    |
| Organization permissions | Members             | Read-only      | Prüfen, ob das Reviewer-Team existiert und Schreibrecht hat                          |

Vergib weder **Workflows** noch **Administration**. Dateien unter `.github/workflows` kommen immer aus dem Repository; Weldall ändert sie nie.

:::note[Repositorys anlegen nutzt alle Rechte der Installation]
Für jeden anderen Vorgang holt Weldall einen Token, der auf ein Repository und die Berechtigungen dieses Vorgangs beschränkt ist. Das Anlegen eines Repositorys aus einem Template ist die Ausnahme: In Tests gegen GitHub gelang es nur mit einem Token, der alle Rechte der Installation trägt, und jeder abgelehnte Versuch hinterließ ein leeres Repository. Weldall nutzt für diesen einen Aufruf deshalb den vollen Token, behält ihn auf dem Server und speichert ihn nicht zwischen. Eine engere Berechtigung lässt sich für das Anlegen von Repositorys nicht zusagen.
:::

## 2. App installieren und Repositorys auswählen

Wähle auf der Seite der App **Install App** und installiere sie in deiner Organisation. Wähle **Only select repositories** und markiere alle Template-Repositorys. Repositorys, die die App später anlegt, kommen automatisch zur Auswahl hinzu.

## 3. Templates kennzeichnen

Jedes Template muss in derselben Organisation liegen und als Template gekennzeichnet sein: Öffne im Repository **Settings → General** und setze das Häkchen bei **Template repository**.

## 4. Privaten Schlüssel erzeugen und übergeben

Wähle auf der Seite der App unter **Private keys** die Option **Generate a private key**. GitHub lädt eine `.pem`-Datei herunter. Notiere die **App ID**, die auf derselben Seite steht.

Mit dem Schlüssel kann jeder als die App handeln. Lade ihn selbst in der Weldall-Admin-Oberfläche hoch (Schritt 6) oder gib ihn über den Secret-Tresor deiner Organisation an die Weldall-Administratoren weiter. Verschicke ihn nie per E-Mail oder Chat. Lösche die heruntergeladene Datei nach dem Hochladen.

## 5. Connector konfigurieren

Beschreibe in deinem IaC-Workspace den Connector, den Scope, der das Veröffentlichen erlaubt, und eine geteilte Verbindung für den Schlüssel. Lege beide deaktiviert an:

```yaml
scopes:
  apps_publish:
    key: apps:publish
    description: Publish apps to GitHub

connectors:
  github:
    key: github
    name: GitHub
    type: github-app
    enabled: false
    envelopeProvider: LOCAL_ENV
    requiredScopes:
      - apps:publish
    provider:
      appId: 123456
      organization: example-org
      apiBaseUrl: https://api.github.com
      templates:
        - name: react
          repository: example-org/react-app-template
      repositoryNamePrefix: app-
      reviewerTeam: app-reviewers
      setupMode: customer-managed
      liveEnvironments:
        - production

sharedConnections:
  github_key:
    key: github-app-key
    connectorKey: github
    name: GitHub App key
    enabled: false
    useScopes:
      - apps:publish
    credentialManagerEmail: admin@example.com
    serviceAccountLabel: GitHub App
    provider:
      kind: github-app-private-key
```

| Feld                   | Bedeutung                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appId`                | Die App ID aus Schritt 4.                                                                                                                                                                                     |
| `organization`         | Die Organisation, der die Templates gehören und in der die Repositorys entstehen.                                                                                                                             |
| `installationId`       | Optional. Fehlt sie, sucht Weldall die Installation der App in der Organisation.                                                                                                                              |
| `apiBaseUrl`           | `https://api.github.com` (Standard). `https://api.<subdomain>.ghe.com` (GitHub Enterprise Cloud mit Datenresidenz) wird akzeptiert, ist aber nicht getestet. GitHub Enterprise Server wird nicht unterstützt. |
| `templates`            | Bis zu 50 Templates. `name` wählen Mitarbeitende und Agenten aus; `repository` ist `owner/name` in der Organisation.                                                                                          |
| `repositoryNamePrefix` | Steht vor jedem neuen Repository-Namen, zum Beispiel `app-expenses`. Darf leer sein, wenn die Organisation nur veröffentlichte Apps enthält.                                                                  |
| `reviewerTeam`         | Der Slug des Teams, das die Pull Requests prüft.                                                                                                                                                              |
| `setupMode`            | `customer-managed`: Deine Organisation sorgt für die Branch-Regel, den Zugriff des Reviewer-Teams und die CI-Secrets. Eine andere Betriebsart gibt es noch nicht.                                             |
| `liveEnvironments`     | GitHub-Deployment-Umgebungen, deren Link der Live-Link der App ist, so geschrieben, wie die CI sie nennt. Links anderer Umgebungen sind Vorschau-Links. Standard: `production`.                               |

Zum Veröffentlichen brauchen Mitarbeitende jeden Scope aus `requiredScopes` des Connectors. Weise ihnen also `apps:publish` zu, zum Beispiel über eine Gruppenzuweisung. Die geteilte Verbindung verwahrt nur den Schlüssel. Das IaC-Schema verlangt dort `useScopes`; trage denselben Scope ein.

Führe `weldall plan` aus, prüfe den Plan und wende ihn mit `weldall up` an.

## 6. Schlüssel hochladen und Connector aktivieren

Öffne in der Weldall-Admin-Oberfläche **Admin → Connections**, wähle die geteilte Verbindung und lade die `.pem`-Datei unter **Provision private key** hoch. Weldall prüft, dass die Datei ein privater RSA-Schlüssel ist, bindet ihn an die konfigurierte App ID und speichert ihn verschlüsselt wie jedes Connector-Credential. Ob GitHub den Schlüssel annimmt, zeigt die Prüfung in Schritt 7. Das Hochladen aktiviert nichts: Setze im Manifest `enabled: true` für den Connector und die geteilte Verbindung und wende es erneut an.

## 7. Einrichtung prüfen

Melde dich als Weldall-Administrator mit `weldall login` an und führe aus:

```sh
weldall connectors check github
```

Der Befehl fragt GitHub nach der Anmeldung der App, ihrer Installation, jeder Berechtigung pro Vorgang, jedem Template, dem Reviewer-Team, der Regel für den Default-Branch und der Commit-Identität. Er liest nur. Jede Zeile ist bestanden, fehlgeschlagen oder nicht prüfbar, jeweils mit Grund und nächstem Schritt. Schlägt eine Pflichtprüfung fehl, endet der Befehl mit Exit-Code `3`. Mit `--json` gibt er den Bericht für Skripte aus.

Solange es noch keine App gibt, lassen sich das Schreibrecht des Reviewer-Teams und die Regel für den Default-Branch nicht prüfen, denn GitHub zeigt beides nur für ein bestehendes Repository. Führe die Prüfung nach der ersten Veröffentlichung erneut aus.

## Einstellungen der Organisation

### Default-Branch schützen

Wir empfehlen ein Ruleset auf Organisationsebene für den Default-Branch aller Repositorys, deren Name mit deinem Präfix beginnt (zum Beispiel `app-*`):

- **Require a pull request before merging** mit mindestens einer Freigabe, und veraltete Freigaben verfallen, wenn neue Commits kommen. Das verhindert auch direkte Pushes.
- **Block force pushes**.
- **Restrict deletions**.

Die Regel ist eine Empfehlung, keine Voraussetzung. Der Git-Proxy von Weldall lehnt jeden Push auf den Default-Branch ohnehin ab, Veröffentlichen funktioniert also auch ohne sie. Die Regel deckt aber ab, was Weldall nicht sieht: Personen und andere Integrationen mit Schreibrecht auf die Repositorys sowie Force-Pushes, die der Proxy nicht erkennt. Rulesets der Organisation kann Weldall nicht lesen. Es prüft die Regeln, die für jedes neue Repository gelten, und meldet eine fehlende Regel als Warnung beim Anlegen des Repositorys und in `weldall connectors check`.

### Reviewer-Team benennen

Lege ein Team an, zum Beispiel `app-reviewers`, dessen Mitglieder ein GitHub-Konto haben und die Apps prüfen. Trage seinen Slug als `reviewerTeam` ein. Weldall fragt bei jedem Pull Request ein Review dieses Teams an.

Das Team braucht Schreibrecht auf jedes neue Repository, und zwar schon in dem Moment, in dem Weldall es anlegt, zum Beispiel über eine Organisationsrolle, die ihm Schreibrecht auf alle Repositorys gibt. Sonst zählen seine Reviews nicht, und die erste Veröffentlichung hält mit einer Meldung für die Administratoren an. Sobald das Team Zugriff hat, setzt eine erneute Veröffentlichung mit demselben Repository fort.

### CI-Secrets

Neue Repositorys bekommen die Dateien des Templates, aber nicht seine Secrets. Stelle der CI neuer Repositorys die nötigen Secrets bereit, zum Beispiel als Secrets der Organisation, deren Repository-Zugriff alle privaten Repositorys umfasst.

:::caution[Vorschauen führen ungeprüften Code aus]
Die Publish-Branches liegen im Repository der App, nicht in einem Fork. Baut die CI des Templates für jeden Pull Request eine Vorschau, führt sie Code aus, den noch niemand geprüft hat, und zwar mit den Secrets, die die CI ihm gibt. Gib Vorschau-Builds nur Zugangsdaten, die für Vorschauen gedacht sind.
:::

### Signierte Commits

Die Commits, die Weldall pusht, sind nicht signiert. Eine Regel, die auf den Branches `weldall/publish-*` signierte Commits verlangt, blockiert jede Veröffentlichung. Wende eine solche Regel nicht auf diese Branches an.

## Was geprüft ist

Vor dem Bau des Connectors wurde von Hand gegen github.com ausprobiert: Installations-Tokens pro Repository ausstellen, ein privates Repository aus einem Template anlegen (samt der abgelehnten engeren Tokens), einen Pull Request öffnen, die Ablehnung von Pushes, die Workflow-Dateien ändern, die Bot-Identität von Commits sowie Pushen und Holen über eine Versuchsfassung des Git-Proxys. Der fertige Connector, einschließlich `weldall connectors check`, ist nur gegen eine nachgebildete GitHub-API und einen lokalen Git-Server getestet. Noch nicht gegen github.com geprüft sind die Berechtigungen Members, Checks, Commit statuses und Deployments, die Anfrage eines Teams als Reviewer, Rulesets der Organisation für neu angelegte Repositorys sowie die Vorschau- und Live-Links.
