---
title: Apps veröffentlichen
description: Mitarbeitende veröffentlichen Apps, die sie mit einem Agenten gebaut haben, auf dem GitHub oder Forgejo der Organisation, ohne Git-Konto; ein Reviewer der Organisation mergt sie.
sidebar:
  label: Apps veröffentlichen
---

Eine Mitarbeitende baut mit einem Agenten auf ihrem Rechner eine kleine App und bittet ihn, sie zu veröffentlichen. Ein GitHub- oder Forgejo-Konto hat sie nicht. Weldall legt für die App ein privates Repository in deiner Organisation an, überträgt die Änderungen und öffnet einen Pull Request. Ein Reviewer in deiner Organisation gibt ihn auf dem Git-Host frei und mergt ihn. Ohne diesen Pull Request gelangt nichts in den Default-Branch. Jede weitere Veröffentlichung schickt die nächste Änderung in dasselbe Repository, wieder als Pull Request.

Die Arbeit auf dem Git-Host erledigt die **Git-App**, ein eigener Dienst, den deine Organisation neben Weldall betreibt, einer pro Git-Host. Die Einrichtung beschreibt [How to: Git-App betreiben](../git-app/); ihr Code liegt in [seibert-external/weldall-git-app](https://github.com/seibert-external/weldall-git-app).

## Was die Mitarbeitende tut

Die Mitarbeitende braucht die Scopes `weldall:login` und `git-app:publish`. Der Agent führt die Befehle im Ordner der App aus, einem Git-Repository, dessen erster Commit das Template ist, mit dem die App begonnen hat. Beim ersten Veröffentlichen bekommt die App einen Namen und einen Zweck:

```sh
weldall app publish --name expenses --purpose "Track team expenses" --json
weldall app publish --title "Add receipt upload" --json
weldall app status --json
```

`--title` und `--body` setzen Titel und Beschreibung des Pull Requests. In einem Desktop-Client mit der Weldall-Erweiterung nutzt der Agent die Werkzeuge `publish_app` und `app_status`, die dieselben Befehle ausführen. Den Ablauf beschreibt dem Agenten der Skill der Git-App im Weldall-Katalog (`<resource key>.publish-app`).

Betreibt die Organisation mehrere Git-Apps, zum Beispiel eine für GitHub und eine für Forgejo, hält die erste Veröffentlichung mit `git_app_ambiguous` an und listet sie auf. Der Agent fragt, wohin die App gehört, und veröffentlicht erneut mit `--git-app <resource key>`. Der Ordner merkt sich die Wahl.

## Was eine Veröffentlichung tut

Jede Veröffentlichung holt den aktuellen Stand des Repositorys, führt ihn mit dem Ordner zusammen und schickt das Ergebnis als einen Commit auf einen Branch namens `weldall/publish-*`. Solange der vorige Pull Request offen ist, aktualisiert Publish ihn. Ist er gemergt oder geschlossen, öffnet die nächste Veröffentlichung einen neuen.

- Dateien, die nach Geheimnissen oder Daten aussehen, lehnt Publish ab, etwa `.env`-Dateien, private Schlüssel, Dateien mit Zugangsdaten, Datenbankdateien und Dumps sowie Dateien über 10 MiB. Dann wird nichts übertragen; das Ergebnis nennt die Dateien und den Grund.
- Workflow-Dateien kommen immer aus dem Repository: `.github/workflows` auf GitHub, auf Forgejo zusätzlich `.forgejo/workflows` und `.gitea/workflows`. Lokale Änderungen daran werden nicht veröffentlicht, und Publish nennt sie in einem Hinweis.
- Hat Publish die Änderung übertragen, den Pull Request aber nicht öffnen können, meldet es `pull_request_not_opened`. Eine erneute Veröffentlichung öffnet den Pull Request, ohne die Änderung noch einmal zu übertragen.

`weldall app sync` holt nur den Stand des Repositorys in den Ordner und veröffentlicht nichts, zum Beispiel nachdem ein Reviewer eine Änderung gemergt hat.

### Konflikte

Haben Ordner und Repository dieselben Zeilen geändert, halten Publish und Sync mit `conflict` an, übertragen nichts und nennen die Dateien. Eine erneute Veröffentlichung mit `--resolve` schreibt das Ergebnis der Zusammenführung mit Konfliktmarkern in den Ordner. Danach entscheidet die Mitarbeitende jede Datei:

```sh
weldall app publish --resolve --json
weldall app publish --decide src/total.ts=folder --decide logo.png=repo --json
```

`folder` übernimmt die Datei, wie sie im Ordner bearbeitet wurde, ohne Marker; `local` und `repo` übernehmen den Stand der jeweiligen Seite.

## Review, Stand und wer mergt

`weldall app status` zeigt den Pull Request mit Reviews und Checks sowie die Vorschau- und Live-Links, die die CI der App meldet. `--app <app-id>` liest eine andere App der Mitarbeitenden.

Die Git-App fordert bei jedem Pull Request ein Review vom Reviewer-Team der Organisation an. Ein Reviewer gibt ihn auf GitHub oder Forgejo frei und mergt ihn. Weder die Mitarbeitende noch der Agent kann über Weldall freigeben oder mergen. Bittet der Reviewer um Änderungen, nimmt die Mitarbeitende sie vor und veröffentlicht erneut; der offene Pull Request wird aktualisiert.

Jede veröffentlichte App steht in der [App-Registry](../app-registry/) ihrer Git-App. Dort sehen Administratoren alle Apps, und Besitzer bestätigen alle 90 Tage, dass sie ihre Apps noch brauchen (`weldall app list`, `weldall app confirm`).

## Was in das Git deiner Organisation gelangt

Nur ein Verweis auf die Person, nie ihr Name oder ihre E-Mail-Adresse:

- Jeder Commit trägt einen Trailer `Weldall-App: <app id>`. Autor der Commits ist die Identität, mit der die Git-App beim Git-Host auftritt: das Bot-Konto der GitHub App oder der Forgejo-Bot-Benutzer.
- Der Text des Pull Requests beginnt mit `Published with Weldall (Weldall user <id>).`, mit der opaken Weldall-Nutzer-ID.

Wer diese Person ist, bleibt außerhalb des Git-Hosts: Die App-Registry der Git-App hält die Weldall-Benutzer-ID fest, das Audit-Log von Weldall die Person.

## Wie Git das Repository erreicht

Git auf dem Rechner der Mitarbeitenden spricht nie mit dem Git-Host. Es pusht zur Git-App und holt von dort, unter `https://git-app.example.com/git/<owner>/<repository>.git`. Die Git-App prüft jede Anfrage, bevor sie etwas weiterleitet:

- Die Git-Anmeldung ist gültig, nennt dieses Repository und gewährt bei einem Push Schreibrecht.
- Weldall bestätigt ohne Zwischenspeichern, dass die Person Weldall noch nutzen darf und `git-app:publish` hat, und die Registry der Git-App, dass sie die App besitzt, die für dieses Repository registriert ist. Ohne beide Antworten wird nichts weitergeleitet.
- Ein Push ändert nur Branches namens `weldall/publish-*`. Die Git-App lehnt Pushes auf den Default-Branch ab, ebenso Tags, das Löschen von Branches, mehr als fünf Branches auf einmal, Push-Optionen, signierte Pushes und Pushes auf den Branch eines geschlossenen oder gemergten Pull Requests. Git zeigt den Grund als `! [remote rejected] … (weldall: …)`.
- Ein Push wird erst weitergeleitet, wenn Weldall seinen Audit-Eintrag gespeichert hat. Sonst zeigt Git `the audit log is unavailable, nothing was pushed`.

Erst dann nutzt die Git-App ihren Zugang zum Git-Host und leitet die Anfrage als Stream dorthin weiter. Auf GitHub holt sie einen Token für genau dieses Repository, mit Lese- oder Schreibrecht auf die Inhalte. Auf Forgejo nutzt sie den Token des Bot-Benutzers, der sich nicht einschränken lässt.

## Was auf den Rechner der Mitarbeitenden gelangt

Provider-Tokens gelangen nie in die CLI, und das gilt auch für den Git-Host: Kein GitHub- oder Forgejo-Token verlässt die Git-App.

Git kann die DPoP-gebundene Anmeldung von Weldall nicht senden. Deshalb arbeitet die CLI als Credential-Helper für Git (`weldall git-credential`). Für jeden Git-Befehl holt sie mit der bestehenden Anmeldung eine **Git-Anmeldung** bei der Git-App und gibt sie Git als Passwort. Die Git-Anmeldung ist kein Token des Git-Hosts:

- Sie gilt fünf Minuten lang, für das Repository einer App und für eine Person.
- Sie erlaubt nur Lesen, es sei denn, Publish fordert Schreibrecht an.
- Sie funktioniert nur an der Git-Route der Git-App und unterliegt allen Regeln oben. Die API des Git-Hosts und andere Repositorys erreicht sie nicht.
- Anders als die Access Tokens von Weldall ist sie **nicht an den Geräteschlüssel gebunden**. Wer sie innerhalb dieser fünf Minuten kopiert, kann das Repository holen und, falls sie Schreibrecht gewährt, auf seine Publish-Branches pushen. Das gilt auch für einen Agenten, der mit den Rechten der Mitarbeitenden auf dem Gerät läuft: Er kann sich eine Git-Anmeldung holen und lesen, obwohl die Weldall-Anleitung es ihm verbietet.
- Die Git-App signiert Git-Anmeldungen und speichert sie nicht. Eine einzelne Git-Anmeldung lässt sich nicht widerrufen, aber wer `git-app:publish` verliert, wird bei der nächsten Git-Anfrage abgewiesen.

Die CLI gibt eine Git-Anmeldung nur an den Origin, den Weldall für die Git-App nennt. Git fragt den Helper nur für die Git-Route dieses Origins, Publish leert dafür alle anderen Credential-Helper, und der Helper speichert nichts. Die Git-Anmeldung landet deshalb nicht im Schlüsselbund.

## Was Weldall protokolliert

Das Audit-Log enthält das Anlegen von Repositorys und das Registrieren bestehender (`git_repository.*`), jeden Push vor dem Weiterleiten und sein Ergebnis (`git_push.*`, mit Person, Repository, Branch, altem und neuem Commit, Größe und Ergebnis), jeden Abruf (`git_fetch.*`), Pull Requests mit ihren Commits (`git_pull_request.*`), jede ausgegebene oder verweigerte Git-Anmeldung (`git_credential.*`) jeden Lauf der Checkliste (`git_host.checked`) und jede Bestätigung, dass eine App noch gebraucht wird (`app_confirmation.*`). Eine Git-Anmeldung gibt die Git-App erst heraus, wenn Weldall ihren Audit-Eintrag gespeichert hat. Auch Ablehnungen stehen im Audit-Log. Ausgenommen ist die erste Anfrage jedes Git-Befehls, denn Git schickt sie immer ohne Anmeldung. Weldall entfernt Zugangsdaten aus den Metadaten jedes Audit-Ereignisses, bevor es sie speichert.

## Grenzen

| Grenze                          | Wert                                  |
| ------------------------------- | ------------------------------------- |
| Anfrage eines Pushes            | 100 MiB                               |
| Antwort eines Abrufs            | 1 GiB                                 |
| Dauer einer Git-Anfrage         | 280 Sekunden                          |
| Gleichzeitige Git-Übertragungen | 16 pro Git-App, 4 pro Person          |
| Git-Anmeldungen                 | 20 pro Person und Minute, pro Git-App |
| Dateien einer Veröffentlichung  | 10 MiB pro Datei, 100 MiB insgesamt   |

Eine typische Veröffentlichung überträgt wenige Kilobyte. Publish braucht Git 2.39 oder neuer.

## Was die Git-App nicht durchsetzen kann

Der Git-Proxy sieht, welchen Branch ein Push ändert, aber nicht, ob der Push Historie umschreibt. Einen Force-Push auf einen Publish-Branch erkennt er nicht. Die Rulesets einer GitHub-Organisation kann die Git-App ebenfalls nicht lesen, nur die Regeln, die für ein bestehendes Repository gelten. Schütze den Default-Branch deshalb auf dem Git-Host mit einer Regel, die einen geprüften Pull Request verlangt und Force-Pushes und Löschen verhindert: siehe [GitHub](../github-app/#default-branch-schützen) und [Forgejo](../forgejo/#5-templates-vorbereiten).

Auf Forgejo kann jemand, der veröffentlichen darf, von Hand eine Workflow-Datei über den Git-Proxy pushen, und Forgejo Actions führt sie vor jedem Review aus. Lies [CI-Secrets und Workflows](../forgejo/#ci-secrets-und-workflows), bevor du das Veröffentlichen auf Forgejo einschaltest.

:::caution[Stand]
Die Git-App und die Publish-Befehle der CLI sind gegen nachgebildete GitHub- und Forgejo-APIs und ein nachgebildetes Weldall getestet, der Git-Proxy gegen einen echten Git-Server. Am 19. November 2026 lief der Ablauf des Veröffentlichens gegen github.com mit einer Test-GitHub-App, der echten CLI und einem lokalen Weldall-Entwicklungsserver, mit einer vorbereiteten Sitzung statt einer Anmeldung im Browser. Noch nicht geprüft sind Checks, Commit-Status und die Vorschau- und Live-Links, ein echtes Reviewer-Team und eine echte Branch-Regel, Forgejo und ein Betrieb mit Produktions-Build; die vollständige Liste steht auf der Seite [Git-App](../git-app/). Die Vorschau- und Live-Links hängen davon ab, dass die CI des App-Templates sie meldet.
:::
