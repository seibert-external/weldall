# Weldall-Schreibstil

Diese Datei beschreibt den verbindlichen Stil für Dokumentation und Produkttexte von Weldall. Sie gilt für deutsche und englische Inhalte und richtet sich an Menschen sowie schreibende Agenten.

## Ziel

Weldall-Texte sind kurz, menschlich und pragmatisch. Leser sollen schnell verstehen:

1. Welches Problem besteht?
2. Was übernimmt Weldall?
3. Was müssen sie selbst tun?
4. Wo finden sie die nächsten Details?

Ein Text ist fertig, wenn er diese Fragen beantwortet. Zusätzliche Sätze brauchen einen konkreten Zweck.

## Ton

Schreibe direkt, ruhig und sachlich. Erkläre das Produkt wie ein erfahrener Kollege, nicht wie eine Marketingbroschüre.

- Verwende aktive Verben und konkrete Subjekte.
- Sprich über beobachtbares Verhalten statt über abstrakte Vorteile.
- Schreibe selbstbewusst, aber nicht absolut.
- Verwende kurze Sätze. Variiere ihre Länge, damit der Text natürlich bleibt.
- Ein Absatz behandelt einen Gedanken.
- Beginne mit der relevanten Aussage. Spare Einleitungen und Ankündigungen.
- Erkläre zuerst das Problem oder ein Beispiel. Technische Details folgen danach.

## Begriffe

Verwende Begriffe konsistent:

- **Mitarbeitende** verwenden Agenten und erteilen Aufträge.
- **Agenten** planen Arbeit und rufen die Weldall CLI auf.
- **Administratoren** verwalten Zugriffe, Ressourcen und Skills. Verwende nicht „IT“ als pauschalen Akteur.
- **Weldall CLI** bezeichnet gegenüber Kunden das Gesamtprodukt aus CLI, Authorization Server und SDKs.
- **Skill** bezeichnet eine Anweisung für den Agenten. Sie zeigt, wie die CLI für die richtigen Requests verwendet wird und welche Scopes erforderlich sind.
- **Scope**, **Access Token**, **DPoP** und andere Protokollbegriffe erscheinen erst, wenn sie für das Verständnis nötig sind.

Benutze für dasselbe Konzept nicht abwechselnd mehrere Synonyme.

## Vom Problem zur Technik

Erkläre Inhalte in dieser Reihenfolge:

1. Beschreibe die Aufgabe aus Sicht eines Menschen.
2. Zeige an einem konkreten Beispiel, was der Agent tut.
3. Erkläre, welchen Teil Weldall übernimmt.
4. Benenne die Verantwortung der Administratoren.
5. Verlinke auf Architektur, Sicherheit oder Referenzdetails.

Ein Beispiel soll reale Handlungen zeigen. „Ein Agent verwaltet Verträge mit `weldall request`“ ist hilfreicher als „Weldall ermöglicht leistungsfähige Unternehmensprozesse“.

## Eine Seite, ein Zweck

Jede Seite beantwortet eine klar abgegrenzte Frage. Wiederhole keine technischen Details, nur um das Produkt erneut abzusichern oder vollständig wirken zu lassen.

- Eine Paketübersicht erklärt Zweck, Voraussetzungen, Installation und einen minimalen Einstieg.
- Eine Anleitung zeigt die nötigen Arbeitsschritte.
- Eine Sicherheitsseite erklärt Token, Schlüssel, Proofs, Autorisierungsabläufe und Standards.
- Verlinke auf die zuständige Seite, statt deren Inhalt zusammenzufassen.
- Verwende eine Info-Box für wichtige Voraussetzungen oder Einschränkungen.
- Erwähne DPoP, Access Tokens oder andere Protokolldetails außerhalb der Sicherheitsdokumentation nur, wenn sie für die konkrete Aufgabe notwendig sind.

Ein Satz gehört nicht auf eine Seite, nur weil er technisch korrekt ist. Er muss dem Zweck der Seite dienen.

## Produktstand und Zielbild

Trenne vorhandene Funktionen von geplanten Funktionen.

- Schreibe im Präsens über den aktuellen Produktstand.
- Kennzeichne geplante Funktionen als Zielbild oder Ausblick.
- Behaupte nicht, dass eine geplante Integration bereits verfügbar ist.
- Verstecke Einschränkungen nicht in Nebensätzen. Nutze bei Bedarf einen eigenen Statusabschnitt.

## Sicherheit

Sicherheitsaussagen müssen stark und technisch belastbar sein.

- Beschreibe die konkrete Garantie.
- Benenne bei Bedarf die Grenze der Garantie.
- Verweise auf offene Standards, statt Sicherheit nur zu behaupten.
- Verwende keine pauschalen Aussagen wie „vollständig sicher“ oder „kein Risiko“.

**Nicht:**

> Tokens können nicht verloren gehen.

**Besser:**

> Der Agent erhält kein Access Token. Kurzlebige Access Tokens sind per DPoP an den Geräteschlüssel gebunden und lassen sich auf einem anderen System nicht wiederverwenden.

## Was wir vermeiden

Streiche Formulierungen, die keinen Informationswert haben:

- „Es ist wichtig zu beachten, dass …“
- „Im Folgenden zeigen wir …“
- „Zusammenfassend …“
- „An dieser Stelle …“
- „In der heutigen digitalen Welt …“
- „nicht nur …, sondern auch …“, wenn die Gegenüberstellung nichts erklärt
- „einfach“, „mühelos“ oder „unkompliziert“, wenn der Text es nicht belegt
- „innovativ“, „nahtlos“, „leistungsstark“, „robust“ oder „ganzheitlich“ als unbelegte Wertung
- werbliche Superlative und Ausrufezeichen
- Wiederholungen der Überschrift im ersten Satz
- Absätze, die nur ankündigen oder zusammenfassen

Diese Wörter sind keine technische Sperrliste. Verwende sie nur, wenn sie eine präzise, belegbare Bedeutung haben.

## Beispiele

**Nicht:**

> Weldall bietet eine innovative und nahtlose Lösung für die sichere Nutzung moderner KI-Agenten im Unternehmen.

**Besser:**

> Weldall steuert, welche Unternehmensfunktionen ein Agent im Namen eines Mitarbeiters aufrufen darf.

**Nicht:**

> Es ist wichtig zu beachten, dass die IT die entsprechenden Berechtigungen konfigurieren muss.

**Besser:**

> Administratoren legen fest, welche Scopes ein Mitarbeiter verwenden darf.

**Nicht:**

> Der Skill beschreibt die verfügbaren Vorgänge der API.

**Besser:**

> Der Skill zeigt dem Agenten die passenden `weldall request`-Befehle.

**Nicht:**

> Das SDK bindet einen Unternehmensservice an Weldall an.

**Besser:**

> Das SDK prüft eingehende Requests, bevor der Downstream-Service Daten liest oder Änderungen ausführt.

**Nicht:**

> Weldall unterstützt verschiedene Anwendungsfälle, beispielsweise im Bereich Vertragsmanagement.

**Besser:**

> Ein Mitarbeiter bittet seinen Agenten, das Prüfdatum eines Vertrags zu ändern. Der Agent findet den passenden Skill und führt den dort beschriebenen `weldall request` aus.

## Überschriften und Navigation

- Überschriften sagen konkret, was der Abschnitt beantwortet.
- Verwende keine generischen Titel wie „Allgemeines“ oder „Weitere Informationen“.
- Seitentitel dürfen beschreibend sein.
- Sidebar-Labels bleiben kurz und sollen nicht umbrechen. Nutze dafür `sidebar.label` im Frontmatter.
- Verwende für Abläufe nummerierte Überschriften.

Beispiel:

```yaml
---
title: Sicherheitsmodell und OAuth-Standards
sidebar:
  label: Sicherheit
---
```

## Deutsch und Englisch

Die deutsche Fassung ist keine Vorlage für eine wörtliche Übersetzung. Beide Fassungen sollen natürlich klingen und dieselbe Aussage treffen.

- Erhalte Fakten, Sicherheitsgarantien und Einschränkungen.
- Übersetze Satzbau und Redewendungen sinngemäß.
- Verwende in Englisch **employees**, **agents** und **administrators**.
- Verwende auch in englischen Texten nicht pauschal **IT** als Akteur.
- Halte Code, Befehle, Scopes und Produktnamen in beiden Sprachen identisch.

## Prüfung vor Veröffentlichung

Prüfe jeden neuen oder geänderten Text:

- Ist der erste Absatz sofort beim Thema?
- Hat jeder Absatz eine Aufgabe?
- Kann ein Satz gestrichen werden, ohne Information zu verlieren? Dann streiche ihn.
- Sind Akteure und Handlungen konkret benannt?
- Trennt der Text Produktstand und Zielbild?
- Sind Sicherheitsaussagen präzise und belegbar?
- Verwendet der Text die festgelegten Begriffe?
- Enthält die englische Fassung dieselben Fakten?
- Sind Seitentitel verständlich und Sidebar-Labels kurz?

Führe anschließend die Format- und Dokumentationsprüfungen des Repositorys aus.
