---
title: "How to: GitHub anbinden"
description: Die GitHub App anlegen, mit der die Git-App die Apps der Mitarbeitenden in deiner GitHub-Organisation veröffentlicht.
sidebar:
  label: "How to: GitHub anbinden"
---

Diese Anleitung richtet sich an die Administratoren der GitHub-Organisation, in der die veröffentlichten Apps landen, und an die Administratoren, die die Git-App betreiben. Was Veröffentlichen bewirkt und wie der Git-Proxy deine Repositorys schützt, beschreibt [Apps veröffentlichen](../publish-apps/); den Dienst und seine Registrierung in Weldall beschreibt [How to: Git-App betreiben](../git-app/).

Du brauchst eine Person mit Owner-Rechten in der GitHub-Organisation und mindestens ein Template-Repository in dieser Organisation.

## 1. GitHub App anlegen

Öffne in GitHub die **Settings** der Organisation und dort **Developer settings → GitHub Apps → New GitHub App**:

- **GitHub App name** und **Homepage URL**: ein beliebiger Name und zum Beispiel die URL der Git-App.
- **Webhook**: Deaktiviere **Active**. Die Git-App empfängt keine Webhooks.
- **Where can this GitHub App be installed?**: **Only on this account**.

Vergib genau diese Berechtigungen:

| Bereich                  | Berechtigung        | Zugriff        | Wofür die Git-App sie braucht                                                        |
| ------------------------ | ------------------- | -------------- | ------------------------------------------------------------------------------------ |
| Repository permissions   | Contents            | Read and write | Über den Git-Proxy holen und pushen, Templates lesen                                 |
| Repository permissions   | Metadata            | Read-only      | Repositorys, ihre Branches und die geltenden Regeln lesen (setzt GitHub automatisch) |
| Repository permissions   | Pull requests       | Read and write | Pull Requests öffnen, das Reviewer-Team anfragen, Reviews lesen                      |
| Repository permissions   | Checks              | Read-only      | Ergebnisse der Checks in `weldall app status` zeigen                                 |
| Repository permissions   | Commit statuses     | Read-only      | Commit-Status in `weldall app status` zeigen                                         |
| Repository permissions   | Deployments         | Read-only      | Die Vorschau- und Live-Links lesen, die die CI der App meldet                        |
| Organization permissions | Repository creation | Read and write | Repositorys aus Templates anlegen                                                    |
| Organization permissions | Members             | Read-only      | Prüfen, ob das Reviewer-Team existiert und Schreibrecht hat                          |

Vergib weder **Workflows** noch **Administration**. Ohne das Workflows-Recht lehnt GitHub jeden Push ab, der eine Datei unter `.github/workflows` ändert; diese Dateien kommen also immer aus dem Repository.

:::note[Repositorys anlegen nutzt alle Rechte der Installation]
Für jeden anderen Vorgang holt die Git-App einen Token, der auf ein Repository und die Berechtigungen dieses Vorgangs beschränkt ist. Das Anlegen eines Repositorys aus einem Template ist die Ausnahme: In Tests gegen GitHub gelang es nur mit einem Token, der alle Rechte der Installation trägt, und jeder abgelehnte Versuch hinterließ ein leeres Repository. Die Git-App nutzt für diesen einen Aufruf deshalb den vollen Token, behält ihn bei sich und speichert ihn nicht zwischen. Eine engere Berechtigung lässt sich für das Anlegen von Repositorys nicht zusagen.
:::

## 2. App installieren und Repositorys auswählen

Wähle auf der Seite der App **Install App** und installiere sie in deiner Organisation. Wähle **Only select repositories** und markiere alle Template-Repositorys. Repositorys, die die App später anlegt, kommen automatisch zur Auswahl hinzu.

## 3. Templates kennzeichnen

Jedes Template muss in derselben Organisation liegen und als Template gekennzeichnet sein: Öffne im Repository **Settings → General** und setze das Häkchen bei **Template repository**.

## 4. Privaten Schlüssel erzeugen und übergeben

Wähle auf der Seite der App unter **Private keys** die Option **Generate a private key**. GitHub lädt eine `.pem`-Datei herunter. Notiere die **App ID**, die auf derselben Seite steht.

Mit dem Schlüssel kann jeder als die App handeln. Er wird zum Host-Secret der Git-App (`GIT_APP_HOST_SECRET_FILE`): Lege ihn selbst im Secret-Manager ab, aus dem der Container der Git-App liest, oder gib ihn über den Secret-Tresor deiner Organisation an die Administratoren weiter, die die Git-App betreiben. Verschicke ihn nie per E-Mail oder Chat. Lösche die heruntergeladene Datei danach. Gib den Schlüssel genau so weiter, wie GitHub ihn erzeugt hat; verschlüsselte Schlüssel werden nicht unterstützt.

## 5. Git-App konfigurieren

Setze `GIT_APP_HOST=github` und gib die Host-Konfiguration als JSON in `GIT_APP_HOST_CONFIG` oder in einer Datei an, die `GIT_APP_HOST_CONFIG_FILE` nennt:

```json
{
  "appId": "123456",
  "organization": "example-org",
  "apiBaseUrl": "https://api.github.com",
  "templates": [{ "name": "react", "repository": "example-org/react-app-template" }],
  "repositoryNamePrefix": "app-",
  "reviewerTeam": "app-reviewers",
  "setupMode": "customer-managed",
  "liveEnvironments": ["production"]
}
```

| Feld                   | Bedeutung                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appId`                | Die App ID aus Schritt 4.                                                                                                                                                                                     |
| `organization`         | Die Organisation, der die Templates gehören und in der die Repositorys entstehen.                                                                                                                             |
| `installationId`       | Optional. Fehlt sie, sucht die Git-App die Installation der App in der Organisation.                                                                                                                          |
| `apiBaseUrl`           | `https://api.github.com` (Standard). `https://api.<subdomain>.ghe.com` (GitHub Enterprise Cloud mit Datenresidenz) wird akzeptiert, ist aber nicht getestet. GitHub Enterprise Server wird nicht unterstützt. |
| `templates`            | Bis zu 50 Templates. `name` wählen Mitarbeitende und Agenten aus; `repository` ist `owner/name` in der Organisation.                                                                                          |
| `repositoryNamePrefix` | Steht vor jedem neuen Repository-Namen, zum Beispiel `app-expenses`. Darf leer sein, wenn die Organisation nur veröffentlichte Apps enthält.                                                                  |
| `reviewerTeam`         | Der Slug des Teams, das die Pull Requests prüft.                                                                                                                                                              |
| `setupMode`            | `customer-managed`: Deine Organisation sorgt für die Branch-Regel, den Zugriff des Reviewer-Teams und die CI-Secrets. Eine andere Betriebsart gibt es noch nicht.                                             |
| `liveEnvironments`     | GitHub-Deployment-Umgebungen, deren Link der Live-Link der App ist, so geschrieben, wie die CI sie nennt. Links anderer Umgebungen sind Vorschau-Links. Standard: `production`.                               |

Die Host-Konfiguration enthält kein Secret. Starte und registriere die Git-App danach wie in [How to: Git-App betreiben](../git-app/) beschrieben.

## 6. Einrichtung prüfen

Melde dich als Weldall-Administrator mit `git-app:admin` per `weldall login` an und führe aus:

```sh
weldall app checklist
```

Die Git-App fragt GitHub nach der Anmeldung der App, ihrer Installation, jeder Berechtigung pro Vorgang, jedem Template, dem Reviewer-Team, der Regel für den Default-Branch und der Commit-Identität. Sie liest nur. Jede Zeile ist bestanden, fehlgeschlagen oder nicht prüfbar, jeweils mit Grund und nächstem Schritt. Schlägt eine Pflichtprüfung fehl, endet der Befehl mit Exit-Code `3`. Mit `--json` gibt er den Bericht für Skripte aus.

Solange es noch keine App gibt, lassen sich das Schreibrecht des Reviewer-Teams und die Regel für den Default-Branch nicht prüfen, denn GitHub zeigt beides nur für ein bestehendes Repository. Führe die Prüfung nach der ersten Veröffentlichung erneut aus, mit `--app <app-id>`.

## Einstellungen der Organisation

### Default-Branch schützen

Wir empfehlen ein Ruleset auf Organisationsebene für den Default-Branch aller Repositorys, deren Name mit deinem Präfix beginnt (zum Beispiel `app-*`):

- **Require a pull request before merging** mit mindestens einer Freigabe, und veraltete Freigaben verfallen, wenn neue Commits kommen. Das verhindert auch direkte Pushes.
- **Block force pushes**.
- **Restrict deletions**.

Die Regel ist eine Empfehlung, keine Voraussetzung. Der Git-Proxy der Git-App lehnt jeden Push auf den Default-Branch ohnehin ab, Veröffentlichen funktioniert also auch ohne sie. Die Regel deckt aber ab, was die Git-App nicht sieht: Personen und andere Integrationen mit Schreibrecht auf die Repositorys sowie Force-Pushes, die der Proxy nicht erkennt. Rulesets der Organisation kann die Git-App nicht lesen. Sie prüft die Regeln, die für jedes neue Repository gelten, und meldet eine fehlende Regel als Warnung beim Anlegen des Repositorys und in `weldall app checklist`.

### Reviewer-Team benennen

Lege ein Team an, zum Beispiel `app-reviewers`, dessen Mitglieder ein GitHub-Konto haben und die Apps prüfen. Trage seinen Slug als `reviewerTeam` ein. Die Git-App fragt bei jedem Pull Request ein Review dieses Teams an.

Das Team braucht Schreibrecht auf jedes neue Repository, und zwar schon in dem Moment, in dem die Git-App es anlegt, zum Beispiel über eine Organisationsrolle, die ihm Schreibrecht auf alle Repositorys gibt. Sonst zählen seine Reviews nicht, und die erste Veröffentlichung hält mit einer Meldung für die Administratoren an. Sobald das Team Zugriff hat, setzt eine erneute Veröffentlichung mit demselben Repository fort.

### CI-Secrets

Neue Repositorys bekommen die Dateien des Templates, aber nicht seine Secrets. Stelle der CI neuer Repositorys die nötigen Secrets bereit, zum Beispiel als Secrets der Organisation, deren Repository-Zugriff alle privaten Repositorys umfasst.

:::caution[Vorschauen führen ungeprüften Code aus]
Die Publish-Branches liegen im Repository der App, nicht in einem Fork. Baut die CI des Templates für jeden Pull Request eine Vorschau, führt sie Code aus, den noch niemand geprüft hat, und zwar mit den Secrets, die die CI ihm gibt. Gib Vorschau-Builds nur Zugangsdaten, die für Vorschauen gedacht sind.
:::

### Signierte Commits

Die Commits, die die CLI für eine Veröffentlichung erzeugt, sind nicht signiert. Eine Regel, die auf den Branches `weldall/publish-*` signierte Commits verlangt, blockiert jede Veröffentlichung. Wende eine solche Regel nicht auf diese Branches an.

## Was geprüft ist

Beim Entwurf des Veröffentlichens wurde von Hand gegen github.com ausprobiert: Installations-Tokens pro Repository ausstellen, ein privates Repository aus einem Template anlegen (samt der abgelehnten engeren Tokens), einen Pull Request öffnen, die Ablehnung von Pushes, die Workflow-Dateien ändern, die Bot-Identität von Commits sowie Pushen und Holen über eine Versuchsfassung des Git-Proxys. Die Git-App ist gegen eine nachgebildete GitHub-API und einen lokalen Git-Server getestet. Am 19. November 2026 lief sie gegen github.com mit einer Test-GitHub-App, der echten CLI und einem lokalen Weldall-Entwicklungsserver: die Prüfliste der Einrichtung, ein Repository aus einem Template anlegen, Holen und Pushen über den Git-Proxy, abgelehnte Pushes, einen Pull Request öffnen, den Status, `weldall app sync` sowie Registry- und Audit-Einträge (damals noch mit der Registry in Weldall). Noch nicht gegen github.com geprüft sind die Berechtigungen Members, Checks, Commit statuses und Deployments (der Test-App fehlten die letzten drei), ein Reviewer-Team mit echtem Schreibzugriff (seine Antwort war nachgebildet) und eine erfolgreiche Review-Anfrage an das Team, eine echte Branch-Regel und Rulesets der Organisation für neu angelegte Repositorys sowie die Vorschau- und Live-Links.
