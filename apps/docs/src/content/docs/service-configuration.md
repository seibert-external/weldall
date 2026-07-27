---
title: "How to: Unternehmensservice integrieren"
description: Einen Web-Service entwickeln, in Weldall registrieren und als Skill für Mitarbeitende bereitstellen.
sidebar:
  label: "How to: Service integrieren"
---

In diesem Walkthrough entsteht ein kleiner Web-Service, der Verträge auflistet. Das Beispiel verwendet Hono, eine moderne und leichtgewichtige Alternative zu Express. Das Weldall SDK stellt dafür eine Hono-Middleware bereit. Für Fetch, Next.js und Astro gibt es weitere Schnittstellen und Adapter auf der Seite [SDKs](../sdks/).

Die Arbeit verteilt sich auf zwei Rollen: Applikationsentwickler sichern den eingehenden Request im Downstream-Service ab. Weldall-Administratoren registrieren den Service, vergeben Berechtigungen und veröffentlichen die Anleitung für Agenten.

## Voraussetzungen

Du benötigst eine laufende Weldall-Instanz und einen Administratorzugang. Falls Weldall noch nicht läuft, beginne mit [How to: Weldall aufsetzen](../weldall-setup/).

Für den Beispielservice benötigst du außerdem:

- Node.js 22.15 oder neuer
- pnpm
- eine HTTPS-URL für den bereitgestellten Service

:::note[Ergebnis]
Am Ende kann ein berechtigter Agent `weldall request --scope contracts:read https://contracts.example.com/api/contracts` ausführen.
:::

## Für Applikationsentwickler

### 1. Hono-Projekt anlegen

Erstelle ein neues Projekt und installiere Hono sowie das Weldall SDK:

```sh
mkdir weldall-contracts
cd weldall-contracts
pnpm init
pnpm pkg set type=module
pnpm add @hono/node-server @weldall/sdk hono
pnpm add --save-dev @types/node tsx typescript
mkdir src
```

### 2. Vertragsservice implementieren

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
  allowInsecureLoopback: publicOrigin.startsWith("http://localhost"),
});

await weldall.ready(); // optional: prüft die Weldall-Konfiguration beim Start

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

`weldall.protect` prüft jeden eingehenden Request, bevor der Handler die Vertragsdaten liest. Der Handler läuft nur, wenn der Request den Scope `contracts:read` erfüllt.

:::note[Replay-Schutz bei horizontaler Skalierung]
`inMemory()` speichert verwendete ID-JAGs und DPoP-Proofs nur im aktuellen Prozess. Bei mehreren Service-Instanzen kennt eine Instanz die Replays nicht, die eine andere bereits gesehen hat. Der Replay-Store verhindert die mehrfache Einlösung eines ID-JAGs und die erneute Verwendung eines DPoP-Proofs; das Access Token selbst wird nicht als einmalig verbraucht markiert.

Weldall stellt ID-JAGs für fünf Minuten und Access Tokens für zehn Minuten aus. Ein DPoP-Proof wird höchstens 60 Sekunden akzeptiert. Entscheide für deinen Anwendungsfall, ob diese begrenzten Zeitfenster ausreichen. Falls nicht, verwende einen gemeinsam genutzten, atomaren Replay-Store. Weitere Hintergründe stehen unter [Sicherheit](../oauth-security/).
:::

### 3. Service lokal starten

Setze die URL deiner Weldall-Instanz und starte den Service:

```sh
WELDALL_ISSUER=https://weldall.example.com \
PUBLIC_ORIGIN=http://localhost:8787 \
pnpm exec tsx src/index.ts
```

Ein Request ohne Weldall-Autorisierung auf `http://localhost:8787/api/contracts` wird abgelehnt. Damit ist der Endpunkt abgesichert.

### 4. Service unter HTTPS bereitstellen

Stelle den Service unter einer öffentlichen HTTPS-URL bereit. Für den restlichen Walkthrough verwenden wir:

```text
https://contracts.example.com
```

Setze `PUBLIC_ORIGIN` in dieser Umgebung auf genau diese URL. Resource Identifier, Endpunkte und die spätere Weldall-Konfiguration müssen denselben Origin verwenden.

## Für Weldall-Administratoren

Öffne die Administrationsoberfläche der Weldall-Instanz.

### 1. Scope anlegen

Öffne **Scopes**, wähle **Create scope** und trage ein:

| Feld        | Wert             |
| ----------- | ---------------- |
| Scope key   | `contracts:read` |
| Description | `Verträge lesen` |

### 2. Resource registrieren

Öffne **Resources**, wähle **Create resource** und verwende diese Werte:

| Feld                 | Wert                                |
| -------------------- | ----------------------------------- |
| Resource key         | `contracts`                         |
| Name                 | `Contracts`                         |
| Resource identifier  | `https://contracts.example.com/api` |
| Authorization server | `https://contracts.example.com`     |
| Downstream client ID | `weldall-cli-at-contracts`          |
| Request prefixes     | `https://contracts.example.com/api` |
| Scopes               | `contracts:read`                    |
| Enabled              | aktiviert                           |

Die Werte müssen zur Konfiguration im Hono-Service passen. Weldall gibt keine Zugangsdaten oder Request-Daten an URLs außerhalb der registrierten Präfixe weiter.

### 3. Skill veröffentlichen

Öffne **Skills**, wähle **Create skill** und trage ein:

| Feld                           | Wert                 |
| ------------------------------ | -------------------- |
| Skill ID                       | `contracts.list`     |
| Title                          | `Verträge auflisten` |
| Required scopes                | `contracts:read`     |
| Hidden without required scopes | aktiviert            |

Verwende diese Markdown-Anweisung:

````md
Liste die Verträge des Unternehmens auf:

```sh
weldall request \
  --scope contracts:read \
  https://contracts.example.com/api/contracts
```

Gib für jeden Vertrag ID, Kunde und Status aus.
````

Der Skill zeigt dem Agenten den vollständigen CLI-Aufruf. Der Agent muss die API nicht selbst herleiten.

### 4. Berechtigung zuweisen

Öffne **Assignments** und erstelle eine Zuweisung für die E-Mail-Adresse des Testnutzers. Weise ihr den Scope `contracts:read` zu.

### 5. Integration testen

Melde dich auf dem Gerät des Testnutzers an und prüfe den veröffentlichten Skill:

```sh
weldall login
weldall skills
weldall skills show contracts.list
```

Anschließend kann der Agent den im Skill beschriebenen Request ausführen:

```sh
weldall request \
  --scope contracts:read \
  https://contracts.example.com/api/contracts
```

Der Service liefert die Vertragsliste zusammen mit der Identität, für die Weldall den Request autorisiert hat. Entfernst du die Zuweisung, wird der gleiche Request abgelehnt und der versteckte Skill nicht mehr angezeigt.
