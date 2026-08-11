# Dokumentations-Workspace mit Astro Starlight

## Ziel

Im Monorepo soll ein eigener Workspace für eine moderne, durchsuchbare Weldall-Dokumentation entstehen. Die Website wird mit [Astro Starlight](https://starlight.astro.build/) umgesetzt, statisch gebaut und automatisiert deployt.

Vorgesehener Workspace:

```text
apps/docs/
├── astro.config.mjs
├── package.json
├── public/
└── src/content/docs/
```

Paketname:

```json
{
  "name": "@weldall/docs",
  "private": true
}
```

## Anforderungen an den Workspace

- Aktuelle Astro- und Starlight-Versionen verwenden.
- Sich als normaler pnpm-/Turbo-Workspace in das Monorepo einfügen.
- Mindestens die Scripts `dev`, `build`, `preview`, `lint` und `typecheck` anbieten.
- Root-Befehle wie `pnpm build`, `pnpm lint`, `pnpm typecheck` und `pnpm format:check` berücksichtigen die Dokumentation.
- Keine eigene Sonderkonfiguration einführen, wenn bestehende TypeScript-, ESLint- oder Prettier-Konfigurationen wiederverwendet werden können.
- Der Produktions-Build ist vollständig statisch und benötigt keinen laufenden Node.js-Server.

## Informationsarchitektur

Die erste Navigation soll mindestens folgende Bereiche enthalten:

1. **Einführung**
   - Was ist Weldall?
   - Architekturüberblick
   - Begriffe: Benutzer, Client, Ressource, Scope, DPoP und ID-JAG
2. **Quickstart**
   - Voraussetzungen und Installation
   - lokale Entwicklungsumgebung
   - Login und erster CLI-Request
3. **CLI**
   - Installation und Updates
   - Commands und Optionen
   - Skills und Scopes entdecken
   - Fehlersuche
4. **Downstream-Integration**
   - Framework-unabhängige Core-Library
   - Hono
   - Next.js
   - Astro
5. **Ressourcen und APIs registrieren**
   - Ressourcenmanifest
   - Skill Registry
   - `weldall up`
   - Ownership und administrative Berechtigungen
6. **Machine-to-Machine**
   - Machine-Identitäten
   - Client Credentials
   - Service-zu-Service-Beispiel
7. **Security und Betrieb**
   - Trust Boundaries
   - Schlüssel und Rotation
   - Replay Store
   - Deployment und Monitoring
8. **Referenz**
   - Konfiguration und Umgebungsvariablen
   - Protokoll- und Claim-Referenz
   - Paket-/API-Referenz
9. **Contributing**
   - Repository-Setup
   - Tests und Builds
   - Dokumentationsbeiträge

Nicht implementierte Funktionen müssen deutlich als geplant, experimentell oder noch nicht verfügbar markiert werden. Die Dokumentation darf die Task-Dateien nicht als bereits ausgelieferte Features darstellen.

## Inhalte migrieren

Bestehende Informationen aus `README.md`, `flow.md`, `plan.md` und `testing.md` prüfen und in passende Seiten überführen bzw. von dort verlinken.

Dabei gilt:

- Die Root-README bleibt ein kurzer Einstieg mit Links zur Dokumentationswebsite.
- Inhalte nicht blind duplizieren; für jedes Thema soll es möglichst eine maßgebliche Quelle geben.
- Architekturentscheidungen und Protokollabläufe mit Mermaid- oder verständlichen Textdiagrammen darstellen.
- Lange Planungsdokumente klar von der aktuellen, unterstützten Funktionsweise trennen.
- Befehle, Dateipfade und Konfigurationen müssen dem tatsächlichen Repository entsprechen.

## Design und Developer Experience

- Weldall-Branding, Logo, Farben und Frosch-Motiv aus der CLI-Branding-Aufgabe wiederverwenden. 🐸
- Gute Lesbarkeit in Light und Dark Mode.
- Responsive Navigation und mobile Darstellung.
- Lokale Volltextsuche oder der von Starlight empfohlene Suchanbieter.
- Copy-Buttons und Syntax-Highlighting für Codebeispiele.
- Sinnvolle Seitentitel, Beschreibungen, Open-Graph-Daten, Favicon und Sitemap.
- Links zu Repository, Releases und Issue Tracker.
- Optional „Edit this page“-Links auf die jeweilige Markdown-/MDX-Datei.
- Barrierearme Farben, Tastaturnavigation und aussagekräftige Linktexte.

## Codebeispiele

- TypeScript als bevorzugte Sprache verwenden.
- Weldall-Host in SDK-Beispielen immer explizit angeben:

```ts
const { protect } = initWeldall("https://weldall.example.com", {
  resource: "https://expenses.example.com",
});
```

- Beispiele dürfen keine echten Secrets, Tokens oder internen Produktions-Hosts enthalten.
- Kopierbare Beispiele müssen vollständig genug sein, um nicht zu unsicheren Annahmen zu führen.
- Soweit praktikabel sollen wichtige Snippets aus getesteten Beispieldateien eingebunden oder in CI kompiliert werden, damit sie nicht veralten.
- Node.js-, Edge- und Framework-spezifische Einschränkungen ausdrücklich nennen.

## Versionierung

Vor der Veröffentlichung entscheiden und dokumentieren:

- ob die Website immer nur die aktuelle Version beschreibt,
- wie Dokumentation für mehrere SDK-/CLI-Versionen bereitgestellt wird,
- wie experimentelle APIs markiert werden,
- wie Breaking Changes und Migration Guides auffindbar bleiben.

Für ein MVP genügt eine Dokumentation der aktuellen Version, sofern jede Seite ihren Stabilitätsstatus klar erkennen lässt.

## Build, Prüfung und Deployment

- CI führt Starlight-Build und Typecheck aus.
- Interne Links, Überschriftenanker und referenzierte lokale Dateien werden geprüft.
- Der Build schlägt bei ungültigen Content Collections oder kaputten internen Links fehl.
- Pull Requests erzeugen nach Möglichkeit ein Vorschau-Artefakt bzw. Preview Deployment.
- Der Main-Branch wird automatisch auf den ausgewählten statischen Host deployt, z. B. GitHub Pages, Cloudflare Pages oder Netlify.
- Base Path, Canonical URL und Asset-Pfade funktionieren sowohl lokal als auch auf dem Zielhost.
- Deployment-Credentials liegen ausschließlich im Secret Store der CI-Plattform.
- Abhängigkeiten und Build-Ausgabe sind reproduzierbar über den pnpm-Lockfile.

## Akzeptanzkriterien

- `apps/docs` ist als `@weldall/docs` Teil des pnpm-/Turbo-Workspaces.
- `pnpm --filter @weldall/docs dev` startet die lokale Starlight-Dokumentation.
- `pnpm --filter @weldall/docs build` erzeugt eine statische, deploybare Website.
- Navigation, Suche, Light/Dark Mode und responsive Darstellung funktionieren.
- Quickstart, CLI, Architektur, Downstream-Integration, M2M und Betrieb besitzen jeweils mindestens eine Einstiegsseite.
- Aktuelle Features und geplante Features sind eindeutig voneinander getrennt.
- Bestehende Dokumente werden sinnvoll verlinkt oder migriert, ohne widersprüchliche Anleitungen zu erzeugen.
- CI prüft Build, Typen und interne Links.
- Ein dokumentierter Deployment-Workflow veröffentlicht die Website auf dem gewählten Host.
- Die Root-README verweist prominent auf die Dokumentation.
