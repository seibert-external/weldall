# Veröffentlichbare Weldall-SDKs für Astro, Next.js und Hono

## Problem

Downstream-Anwendungen müssen aktuell OAuth-, ID-JAG-, DPoP-, Token- und Scope-Logik selbst integrieren. Teile davon liegen bereits in `@weldall/oauth`, die vorhandene Hono-Integration ist jedoch eng an interne Details gekoppelt und das Paket ist nicht veröffentlichbar (`private: true`).

Für Astro, Next.js und Hono sollen einfach nutzbare, deploybare Libraries entstehen. Die Framework-Pakete sollen möglichst dünne Adapter um eine gemeinsame interne Core-Library sein, damit sicherheitskritische Logik nicht mehrfach implementiert wird.

## Ziel

Anwendungen sollen Weldall mit wenigen Zeilen korrekt anbinden können. Bei jeder Initialisierung muss der verwendete Weldall-Host explizit angegeben werden; es darf keinen versteckten produktiven Default geben.

Angestrebte Form:

```ts
import { initWeldall } from "@weldall/hono";

const weldall = initWeldall("https://weldall.example.com");
```

Oder mit Destructuring:

```ts
const { protect, getIdentity } = initWeldall("https://weldall.example.com");
```

Die endgültigen Namen und Rückgabewerte sind Teil des API-Designs. Wichtig sind eine konsistente API über alle Frameworks und ein verpflichtender Weldall-Host.

## Paketstruktur

Vorgeschlagene Aufteilung:

```text
@weldall/core     Framework-unabhängige Protokoll- und Sicherheitslogik
@weldall/hono     Middleware und Context-Helfer für Hono
@weldall/next     Route-Handler-/Server-Helfer für Next.js
@weldall/astro    Middleware und Endpoint-Helfer für Astro
```

Alternativ kann bestehende Logik aus `@weldall/oauth` nach `@weldall/core` verschoben oder `@weldall/oauth` zur Core-Library weiterentwickelt werden. Es soll nur eine maßgebliche Implementierung für Tokenprüfung, DPoP, Discovery, Scope-Prüfung und OAuth-Fehler geben.

Framework-Pakete dürfen die Core-Library verwenden, aber keine Crypto- oder Protokolllogik kopieren.

## Gemeinsame Core-Funktionen

Die Core-Library soll mindestens die wiederverwendbaren Bausteine bereitstellen für:

- Validierung und Normalisierung des Weldall-Hosts,
- Discovery von Weldall-Metadaten und JWKS,
- sichere JWKS-Zwischenspeicherung und Key-Rotation,
- Prüfung von Issuer, Audience, Signatur, Ablaufzeit und Token-Typ,
- DPoP-Prüfung einschließlich URL-Bindung und Replay-Schutz,
- Scope-Prüfung mit „alle“-/gegebenenfalls „mindestens einer“-Semantik,
- typisierte Identity-/Principal- und Auth-Context-Objekte,
- standardkonforme OAuth-Fehler und `WWW-Authenticate`-Header,
- Protected-Resource-Metadaten,
- optional ID-JAG-Einlösung und lokale Access-Token-Ausstellung,
- optional ausgehende, authentisierte Requests an andere Weldall-Ressourcen.

Es ist vorab festzulegen, ob Version 1 nur **eingehende Requests schützen** soll oder auch den kompletten Authorization-Server-/Downstream- und Outbound-Client-Flow abstrahiert. Die API soll spätere Erweiterungen ermöglichen, ohne Framework-Anwendungen an interne Protokolldetails zu koppeln.

## Initialisierung und Konfiguration

Der Weldall-Host ist ein verpflichtendes erstes Argument:

```ts
const weldall = initWeldall("https://weldall.example.com", {
  resource: "https://expenses.example.com",
  publicOrigin: "https://expenses.example.com",
});
```

Anforderungen:

- Kein Default auf localhost oder einen fest codierten Weldall-Host.
- Ungültige URLs werden beim Start abgelehnt.
- Produktions-Hosts müssen HTTPS verwenden; unsicheres HTTP ist nur explizit für lokale Entwicklung erlaubt.
- Der Host wird kanonisch normalisiert und nicht aus untrusted Request-Headern abgeleitet.
- Pflichtoptionen sollen möglichst über Weldall- bzw. Protected-Resource-Discovery ermittelt werden.
- Nicht ableitbare sicherheitsrelevante Werte wie Resource Identifier oder öffentliche Origin müssen explizit angegeben werden.
- Secrets werden über sichere Runtime-Konfiguration bzw. Callbacks geladen, nicht als Teil öffentlicher Client-Konfiguration gebündelt.
- Fehlende Konfiguration führt zu einem frühen, verständlichen Fehler statt zu permissivem Verhalten.

## Gewünschte Developer Experience

### Hono

```ts
import { Hono } from "hono";
import { initWeldall } from "@weldall/hono";

const app = new Hono();
const { protect, getIdentity } = initWeldall("https://weldall.example.com", {
  resource: "https://expenses.example.com",
  publicOrigin: "https://expenses.example.com",
});

app.get("/expenses", protect({ scopes: ["expenses:read"] }), (c) => {
  const identity = getIdentity(c);
  return c.json({ subject: identity.subject });
});
```

### Next.js

```ts
import { initWeldall } from "@weldall/next";

const { withWeldall } = initWeldall("https://weldall.example.com", {
  resource: "https://expenses.example.com",
  publicOrigin: "https://expenses.example.com",
});

export const GET = withWeldall(
  { scopes: ["expenses:read"] },
  async (_request, auth) => Response.json({ subject: auth.identity.subject }),
);
```

Die unterstützten Next.js-Runtimes müssen explizit dokumentiert werden. Node.js und Edge dürfen nicht implizit gleichgesetzt werden, wenn Crypto-, Netzwerk- oder Replay-Store-Abhängigkeiten nicht kompatibel sind.

### Astro

```ts
import { defineMiddleware } from "astro:middleware";
import { initWeldall } from "@weldall/astro";

const { protect } = initWeldall("https://weldall.example.com", {
  resource: "https://expenses.example.com",
  publicOrigin: "https://expenses.example.com",
});

export const onRequest = defineMiddleware(
  protect({ scopes: ["expenses:read"] }),
);
```

Die Beispiele beschreiben die gewünschte Einfachheit, nicht zwingend die endgültigen Funktionssignaturen.

## Framework-Adapter

Jeder Adapter soll ausschließlich Framework-Aufgaben übernehmen:

- Request und URL korrekt in das Core-Format übersetzen,
- Middleware-/Handler-Lifecycle des Frameworks bedienen,
- Identity und Scopes typisiert im jeweiligen Context verfügbar machen,
- Core-Fehler in passende Framework-Responses umwandeln,
- Server-only Code zuverlässig von Client Bundles fernhalten,
- Runtime- und Deployment-Besonderheiten dokumentieren.

Alle Adapter sollen dieselben Begriffe, Scope-Semantik, Fehlercodes und Sicherheitsdefaults verwenden.

## Replay Store und Skalierung

Der derzeitige prozesslokale Replay Store genügt nicht für horizontal skalierte Deployments. Das SDK benötigt eine klare Abstraktion:

```ts
initWeldall(host, {
  replayStore: redisReplayStore(redis),
});
```

- Ein In-Memory-Store darf als Development-Default angeboten werden.
- In Produktion mit mehreren Instanzen muss ein geteilter Store konfigurierbar sein.
- Unsichere Skalierungskonfigurationen sollen mindestens deutlich warnen oder optional hart fehlschlagen.
- Store-Verträge, TTL, atomarer Consume und Fehlerverhalten müssen spezifiziert und getestet werden.

## Veröffentlichung und Distribution

- Pakete erhalten veröffentlichbare Namen, Versionen, Lizenzen und README-Dateien.
- `private: true` und interne `workspace:*`-Abhängigkeiten dürfen nicht in publizierten Artefakten verbleiben.
- ESM, TypeScript-Typen und Package-Exports werden korrekt ausgeliefert.
- Frameworks werden soweit sinnvoll als Peer Dependencies geführt.
- Node-/Edge-/Web-Runtime-Anforderungen werden über Exports und Dokumentation klar getrennt.
- Publish-Artefakte enthalten keine Tests, Secrets, internen Konfigurationen oder unnötigen Workspace-Code.
- CI baut, testet und prüft die gepackten Tarballs in frischen Beispielprojekten.
- Versionierung und Releases der Core- und Adapter-Pakete werden gemeinsam oder kompatibel koordiniert.
- Ein reproduzierbarer Publishing-Workflow veröffentlicht die Pakete in die gewählte Registry.

## Sicherheitsanforderungen

- Host, Issuer und Audience werden niemals nur aufgrund von Token-Claims vertraut.
- Discovery und JWKS-Fetches sind gegen SSRF, Redirect-Missbrauch und unerwartete Origins abgesichert.
- Authentisierung schlägt bei Netzwerk-, Discovery-, Key- oder Konfigurationsfehlern geschlossen fehl.
- Token, DPoP-Proofs, Assertions und Secrets werden nicht geloggt.
- Proxy-Header werden nur bei explizit konfigurierten Trusted Proxies berücksichtigt.
- Scope-Checks sind für Handler deklarativ sichtbar und standardmäßig restriktiv.
- Identity-Daten sind erst nach erfolgreicher Middleware-Prüfung zugänglich.
- Key-Rotation darf weder dauerhafte Ausfälle noch die Akzeptanz unbekannter Schlüssel verursachen.
- Abhängigkeiten und gebündelter Code werden auf bekannte Schwachstellen und versehentliche Client-Side-Bundles geprüft.

## Dokumentation und Beispiele

Für jedes Framework wird ein minimales, ausführbares Beispiel bereitgestellt, das zeigt:

1. Installation,
2. Initialisierung mit verpflichtendem Weldall-Host,
3. Schutz einer Route mit Scopes,
4. Zugriff auf die authentisierte Identity,
5. lokale Entwicklung,
6. produktive Konfiguration einschließlich Replay Store,
7. typische Fehler und deren Behebung.

Zusätzlich soll eine Migrationsanleitung zeigen, wie die bestehende Expenses-Hono-Anwendung auf das veröffentlichte SDK umgestellt wird.

## Akzeptanzkriterien

- Eine Framework-unabhängige Core-Library enthält die gemeinsame Sicherheits- und Protokolllogik.
- Veröffentlichbare Adapter für Hono, Next.js und Astro verwenden diese Core-Library ohne duplizierte Token-/DPoP-Implementierung.
- `initWeldall(...)` verlangt in jedem Paket explizit einen Weldall-Host und lehnt fehlende oder ungültige Hosts früh ab.
- Je Framework lässt sich eine Route mit höchstens wenigen deklarativen Zeilen durch einen oder mehrere Scopes schützen.
- Handler erhalten eine typisierte, verifizierte Identity und die gewährten Scopes.
- Alle Adapter erzeugen für äquivalente Fehler konsistente Statuscodes, OAuth-Fehler und Header.
- Mindestens ein Test je Adapter deckt gültige Tokens, falschen Issuer, falsche Audience, fehlende Scopes und DPoP-Replay ab.
- Gepackte Releases lassen sich in frischen Astro-, Next.js- und Hono-Projekten installieren, bauen und starten.
- Die bestehende Expenses-App verwendet anschließend den Hono-Adapter statt eigener Integrationslogik.
- Unterstützte Framework- und Runtime-Versionen sowie Einschränkungen sind dokumentiert.
