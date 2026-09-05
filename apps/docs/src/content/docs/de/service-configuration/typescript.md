---
title: Einen Webdienst mit TypeScript absichern
description: Mit dem Weldall SDK und Hono eine Vertrags-API absichern und Anweisungen für Agenten veröffentlichen.
sidebar:
  label: TypeScript
---

Weldall prüft eingehende Anfragen an Webdienste. Dafür bieten wir Bibliotheken an, die du in deine Anwendung einbindest. Sie prüfen, wer eine Anfrage stellt und ob die nötigen Berechtigungen vorliegen, bevor die Anwendung Daten liest oder Änderungen ausführt.

Für TypeScript gibt es die Bibliothek `@weldall/sdk`. Diese Anleitung zeigt ihren Einsatz mit Hono: Ein Webdienst gibt eine Vertragsliste nur mit der Berechtigung `contracts:read` zurück. Dazu veröffentlicht er einen Skill, also eine Anleitung mit dem passenden Befehl für den Agenten.

Du benötigst Node.js 22.15 oder neuer, pnpm und eine laufende Weldall-Instanz. [Quellcode und Referenz der TypeScript-Bibliothek](https://github.com/seibert-external/weldall/tree/main/packages/sdk) findest du auf GitHub, das veröffentlichte Paket auf [npm](https://www.npmjs.com/package/@weldall/sdk).

## 1. Hono-Projekt anlegen

```sh
mkdir weldall-contracts
cd weldall-contracts
pnpm init
pnpm pkg set type=module
pnpm add @hono/node-server @weldall/sdk hono
pnpm add --save-dev @types/node tsx typescript
mkdir src
```

## 2. Zugriff auf Verträge absichern

Lege `src/index.ts` an:

```ts
import { serve } from "@hono/node-server";
import { generateEs256KeyPair, inMemory } from "@weldall/sdk";
import { initWeldall, type WeldallVariables } from "@weldall/sdk/hono";
import { Hono } from "hono";

const weldallIssuer = process.env.WELDALL_ISSUER ?? "https://weldall.example.com";
const publicOrigin = process.env.PUBLIC_ORIGIN ?? "http://localhost:8787";
const key = await generateEs256KeyPair();

const weldall = initWeldall(weldallIssuer, {
  resource: `${publicOrigin}/api`,
  publicOrigin,
  clientId: "weldall-cli-at-contracts",
  supportedScopes: ["contracts:read"],
  signingKey: {
    kid: "development-only",
    privateJwk: key.privateJwk,
    publicJwk: key.publicJwk,
  },
  replayStore: inMemory(),
  skills: {
    items: [
      {
        id: "list",
        title: "List contracts",
        requiredScopes: ["contracts:read"],
        visibility: "HIDDEN_IF_UNALLOWED",
        content: `# List contracts\n\nRun \`weldall request --scope contracts:read ${publicOrigin}/api/contracts\`.`,
      },
    ],
  },
  allowInsecureLoopback: publicOrigin === "http://localhost:8787",
});

const app = new Hono<{ Variables: WeldallVariables }>();
weldall.registerRoutes(app);

app.get("/api/contracts", weldall.protect({ scopes: ["contracts:read"] }), (context) => {
  const auth = weldall.getAuth(context);
  return context.json({
    requestedBy: auth.identity.subject,
    contracts: [
      { id: "contract-1001", customer: "Nordstern GmbH", status: "active" },
      { id: "contract-1002", customer: "Südwind AG", status: "review" },
    ],
  });
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) });
```

`registerRoutes()` stellt die Endpunkte bereit, über die Weldall den Dienst erkennt, Signaturschlüssel und Skills abruft und Berechtigungsnachweise gegen Zugangstokens eintauscht. `protect()` prüft die Berechtigung, bevor die Funktion zum Auflisten der Verträge ausgeführt wird. Mit `getAuth()` kann sie anschließend die geprüfte Identität lesen. Wie du diese Identität den Benutzerkonten deiner Anwendung zuordnest, legst du selbst fest.

Der Skill zeigt dem Agenten den passenden Aufruf. Mitarbeitende ohne `contracts:read` sehen ihn nicht. Diese Einstellung ersetzt jedoch nicht die Berechtigungsprüfung beim Zugriff auf die Vertragsliste.

## 3. Webdienst lokal prüfen

Trage unter `WELDALL_ISSUER` die Adresse deiner Weldall-Instanz ein und starte den Webdienst:

```sh
WELDALL_ISSUER=https://weldall.example.com \
PUBLIC_ORIGIN=http://localhost:8787 \
pnpm exec tsx src/index.ts
```

Rufe in einem zweiten Terminal die Dienstbeschreibung und die geschützte Vertragsliste ab:

```sh
curl -i http://localhost:8787/.well-known/oauth-protected-resource
curl -i http://localhost:8787/api/contracts
```

Die Dienstbeschreibung liefert den Statuscode `200` und die Ressourcenkennung `http://localhost:8787/api`. Die Anfrage nach Verträgen wird mit `401` abgelehnt, weil der Berechtigungsnachweis fehlt. Für diese Prüfung brauchst du keine Anmeldung an der Weldall CLI. Mit `await weldall.ready()` vor dem Serverstart kannst du zusätzlich prüfen, ob die Bibliothek die Konfiguration deiner Weldall-Instanz abrufen kann und die Signaturschlüssel korrekt eingerichtet sind.

## 4. Webdienst bereitstellen und registrieren

:::caution[Replay-Schutz bei mehreren Instanzen]
Jeder DPoP-Proof enthält eine eindeutige ID (`jti`). Das SDK speichert bereits verwendete IDs und lehnt wiederverwendete Proofs ab. Mit `inMemory()` funktioniert das nur innerhalb eines Prozesses.

Die Proofs sind zwar nur kurz gültig, können in dieser Zeit aber an einer anderen Instanz erneut verwendet werden. Für Replay-Schutz über alle Instanzen hinweg brauchst du einen gemeinsamen Replay-Store, etwa auf Basis von Redis. Er muss neue IDs atomar eintragen, Duplikate ablehnen und die IDs bis zum Ende des Gültigkeitsfensters speichern. Details stehen unter [Sicherheit](../../oauth-security/).
:::

Verwende in Produktion HTTPS und lade deinen ES256-Signaturschlüssel aus der Konfiguration, statt ihn wie im Beispiel bei jedem Start neu zu erzeugen.

Stelle den Webdienst unter `https://contracts.example.com` bereit und setze `PUBLIC_ORIGIN` auf genau diese URL. `WELDALL_ISSUER` zeigt weiterhin auf deine Weldall-Instanz. Die Ressourcenkennung lautet dann `https://contracts.example.com/api`. Auch der Skill verwendet nun die öffentliche Adresse.

Fahre mit der [Registrierung und Berechtigungsvergabe](../#für-weldall-administratoren) fort. Diese Schritte sind für TypeScript und Python identisch.

## Beispiele für weitere Bibliotheken auf GitHub

Im [Weldall-Projekt auf GitHub](https://github.com/seibert-external/weldall) findest du diese Beispielverzeichnisse. Die jeweilige README-Datei erklärt, wie du das Beispiel startest:

| Verzeichnis                                                                                | Verwendung                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| [`examples/hono`](https://github.com/seibert-external/weldall/tree/main/examples/hono)     | Anfragen mit Hono prüfen                                      |
| [`examples/basic`](https://github.com/seibert-external/weldall/tree/main/examples/basic)   | Die Fetch-Schnittstelle ohne zusätzliches Webframework nutzen |
| [`examples/next`](https://github.com/seibert-external/weldall/tree/main/examples/next)     | Anfragen mit Next.js unter Node.js verarbeiten                |
| [`examples/astro`](https://github.com/seibert-external/weldall/tree/main/examples/astro)   | Endpunkte mit Astro bereitstellen und absichern               |
| [`examples/skills`](https://github.com/seibert-external/weldall/tree/main/examples/skills) | Einen Skill-Katalog veröffentlichen                           |

Die Beispiele für Hono, Next.js und Astro verwenden eine Ausgaben-API statt der Vertrags-API aus dieser Anleitung. Übernimm bei der Registrierung in Weldall die Ressourcenkennung, die Client-ID und die Scopes aus dem gewählten Beispiel.
