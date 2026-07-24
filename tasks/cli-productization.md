# CLI benutzerfreundlich gestalten und distribuierbar machen

## Ziel

Die Weldall-CLI soll sich wie ein modernes, freundliches Kommandozeilen-Tool anfühlen und als direkt ausführbares Artefakt veröffentlicht werden können.

## Aufgaben

### Benutzerfreundlichkeit

- Eine moderne CLI-Bibliothek evaluieren und einsetzen, z. B. `commander`, `citty` oder `oclif`.
- Verständliche Commands, Optionen, Hilfetexte und Fehlermeldungen bereitstellen.
- Konsistente Farben, Spinner, Fortschrittsanzeigen und Exit-Codes verwenden; nicht-interaktive und `NO_COLOR`-Umgebungen berücksichtigen.
- Eingaben validieren und bei Fehlern konkrete Lösungshinweise anzeigen.
- Bestehende Commands und ihr Verhalten möglichst kompatibel halten.

### Branding und Darstellung

- Ein freundliches Weldall-Logo für Start- und Hilfsansichten entwerfen.
- Ein hübsches Tier als ASCII-/Unicode-Art anzeigen, passend zum Weldall-Branding (z. B. ein Frosch).
- Darstellung für schmale Terminals sowie Terminals ohne Farbe oder Unicode sinnvoll degradieren lassen.
- Logo und Tier nicht bei maschinenlesbarer Ausgabe oder nicht-interaktiver Verwendung ausgeben.

### Build, CI und Veröffentlichung

- Eine reproduzierbare Build- und Release-Chain definieren.
- CI für Linting, Typechecks, Tests und Build einrichten.
- Versionierung und Publishing automatisieren, inklusive Changelog bzw. Release Notes.
- Pro unterstützter Plattform ein eigenständig ausführbares Artefakt erzeugen, das nach Möglichkeit keine lokale Node.js-Installation voraussetzt.
- Artefakte sinnvoll benennen, komprimieren und mit Checksummen veröffentlichen.
- Einen Distributionsweg festlegen und dokumentieren, z. B. GitHub Releases, npm und optional Homebrew.
- Installation, Update und Deinstallation in der README dokumentieren.

## Technische Entscheidungen

Vor der Umsetzung festlegen und kurz dokumentieren:

1. Welche CLI-/UI-Bibliothek verwendet wird und warum.
2. Welche Plattformen und Architekturen offiziell unterstützt werden.
3. Welcher Bundler bzw. Packager das Executable erzeugt, z. B. Node SEA, Bun oder `pkg`/Nachfolger.
4. Wie native Abhängigkeiten wie `@napi-rs/keyring` paketiert und je Plattform getestet werden.
5. Wie Releases ausgelöst, versioniert, signiert und veröffentlicht werden.

## Akzeptanzkriterien

- `weldall --help` ist übersichtlich, gebrandet und dokumentiert alle Commands und Optionen.
- Interaktive Ausgaben zeigen ein ansprechendes Logo bzw. Tier; CI, Pipes und maschinenlesbare Ausgabe bleiben sauber.
- Fehler liefern eine verständliche Meldung, einen passenden Exit-Code und nach Möglichkeit einen Lösungshinweis.
- Die CI führt Linting, Typechecks, Tests und Build erfolgreich aus.
- Ein versionierter Release-Workflow erstellt installierbare Executables für alle unterstützten Zielplattformen.
- Ein frisch heruntergeladenes Artefakt lässt sich gemäß Dokumentation installieren und mit `weldall --version` sowie `weldall --help` ausführen.
- Checksummen und Release Notes werden zusammen mit den Artefakten veröffentlicht.
- Mindestens ein dokumentierter Distributionsweg ist vollständig nutzbar.
