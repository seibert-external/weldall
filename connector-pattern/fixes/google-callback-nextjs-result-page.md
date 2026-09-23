# Fix: Google-Callback über eine normale Next.js-Ergebnisseite darstellen

## Problem

`GET /api/connectors/google/callback` verarbeitet den OAuth-Callback korrekt, liefert das Ergebnis aber als handgeschriebenes HTML mit eingebettetem CSS aus `server/connectors/callback-page.ts` aus. Eine Prüfung der aktuellen Dev-URL bestätigt, dass die Seite nur dieses Inline-Dokument lädt und weder den normalen App-Renderpfad noch das Weldall-Theme verwendet.

Dadurch umgeht die Callback-UI:

- das Root-Layout und die gemeinsamen Provider,
- das ASTRYX-Theme,
- vorhandene ASTRYX-Komponenten,
- bestehende Weldall-Styles und Bestätigungsseiten,
- die normale Next.js-Metadata- und Teststruktur.

Das Ergebnis wirkt deshalb wie eine separate Mini-Anwendung und nicht wie Weldall.

## Vorhandenes Pattern

`app/login/test-result/page.tsx` ist bereits eine einfache Bestätigungsseite für einen Browser-Flow. Sie nutzt:

- einen normalen App-Router-`page.tsx`,
- `login-shell`, `login-panel` und `login-auth-panel`,
- das Weldall-Logo,
- ASTRYX `VStack`, `Heading` und `Text`,
- validierte `searchParams`,
- `force-dynamic`, `noindex` und `no-referrer`.

Die Connector-Ergebnisseite sollte dieses Pattern wiederverwenden, statt ein zweites visuelles System zu pflegen.

## Randbedingung von Next.js

Ein `route.ts` und ein `page.tsx` können nicht dasselbe URL-Segment besitzen, da beide die Route übernehmen würden. Der OAuth-Callback muss außerdem eine einmalige Mutation ausführen und gehört deshalb weiterhin in einen Route Handler. Die Verarbeitung direkt beim Rendern einer Server-Component wäre ungeeignet: Reloads oder erneutes Rendern könnten den einmal verwendbaren OAuth-Code nochmals verarbeiten.

Quellen:

- [Next.js Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers)
- [NextResponse.redirect](https://nextjs.org/docs/app/api-reference/functions/next-response)
- [App Router page.js und searchParams](https://nextjs.org/docs/app/api-reference/file-conventions/page)

## Vorgeschlagener Ablauf

```text
Google
  → GET /api/connectors/google/callback?state=…&code=…
  → Route Handler validiert und verarbeitet den OAuth-Callback
  → 303 Redirect auf /connectors/google/result?kind=success
  → normaler Next.js page.tsx rendert die ASTRYX-Ergebnisseite
```

Der bestehende API-Callback bleibt die bei Google registrierte Redirect URI. Er gibt nach der Verarbeitung kein HTML mehr zurück, sondern ausschließlich einen Redirect auf eine separate, öffentliche Ergebnisseite.

Die vier vorhandenen Zustände bleiben erhalten:

- `success`
- `cancelled`
- `invalid`
- `failure`

In die Redirect-URL gehört **nur** dieser feste Enum-Wert. OAuth-Code, State, Fehlermeldungen, Connection-Name, Google-Adresse und andere Nutzerdaten dürfen nicht weitergereicht werden. Connection- und Account-Details zeigt anschließend bereits die wartende CLI; die Browserseite braucht sie nicht. Dadurch sind weder zusätzlicher Datenbankspeicher noch ein Ergebnis-Cookie oder ein signiertes Ticket nötig.

## Vorgeschlagene Next.js-Seite

Neue Route:

```text
apps/weldall/src/app/connectors/google/result/page.tsx
```

Die Seite sollte:

1. `searchParams` mit einem strikten Zod-Schema auf `kind` validieren,
2. für unbekannte oder mehrfach vorhandene Werte `notFound()` verwenden,
3. die vorhandenen Texte pro Zustand aus einer typisierten Map beziehen,
4. das bestehende `login/test-result`-Layout wiederverwenden,
5. ASTRYX `VStack`, `Heading`, `Text` und bei Bedarf `Icon` oder `Banner` verwenden,
6. keine Client Component und kein eigenes Stylesheet benötigen,
7. `dynamic = "force-dynamic"` sowie Metadata mit `robots: noindex` und `referrer: no-referrer` setzen.

Visuell genügt bewusst eine einfache Bestätigung:

```text
┌──────────────────────────────────────┐
│               WELDALL                │
│                                      │
│  ✓ Google connected                  │
│                                      │
│  Your Google account is ready to     │
│  use through Weldall.                │
│                                      │
│  Close this window and return to     │
│  the CLI.                            │
└──────────────────────────────────────┘
```

Fehlerzustände verwenden dieselbe Struktur mit passendem ASTRYX-Status und Text. Ein „Fenster schließen“-Button ist nicht nötig: Browser erlauben `window.close()` für normal geöffnete Tabs nicht zuverlässig. Die klare Rückkehranweisung reicht aus.

## Änderungen am Callback Handler

`app/api/connectors/google/callback/route.ts` behält Query-Validierung, Audit-IDs und die Aufrufe von `completeAuthorizationCallback` beziehungsweise `rejectAuthorizationCallback`. Statt `connectorCallbackPage(...)` erzeugt der Handler eine lokale Ziel-URL auf Basis von `request.url` und antwortet mit einem `303`-Redirect.

Beispielhaft:

```ts
function resultRedirect(request: Request, kind: ResultKind) {
  const target = new URL("/connectors/google/result", request.url);
  target.searchParams.set("kind", kind);
  return NextResponse.redirect(target, 303);
}
```

Das feste lokale Ziel verhindert Open Redirects. Der Callback-Response sollte weiterhin `Cache-Control: no-store` und `Referrer-Policy: no-referrer` setzen, damit die eingehende URL mit OAuth-Code und State nicht gecacht oder als Referrer weitergegeben wird.

## Entfernen

Nach der Umstellung können entfallen:

- `apps/weldall/src/server/connectors/callback-page.ts`,
- das handgeschriebene HTML und Inline-CSS,
- HTML-Escaping, das nur für dieses Dokument nötig ist,
- `apps/weldall/test/connector-callback-page.test.ts` in seiner aktuellen Form.

Stattdessen sollten Tests die Resultat-Zuordnung und Redirect-Ziele des Route Handlers sowie die vier Texte der normalen Ergebnisseite abdecken. Kein Test darf OAuth-Code oder State im `Location`-Header finden.

## Akzeptanzkriterien

- Der Google-Callback bleibt unter der bestehenden `/api/connectors/google/callback`-URL erreichbar.
- Jeder Callback-Ausgang führt per lokalem Redirect zur normalen Next.js-Ergebnisseite.
- Die Ergebnisseite wird über Root-Layout, Provider, Weldall-Theme und ASTRYX gerendert.
- Sie entspricht visuell dem vorhandenen `login/test-result`-Pattern.
- OAuth-Code, State und persönliche Connection-Daten erscheinen nicht in der Ergebnis-URL.
- Reloading der Ergebnisseite verarbeitet den OAuth-Callback nicht erneut.
- Callback- und Ergebnisseite werden nicht indexiert oder mit sensitiven Referrern weitergegeben.
- Das handgeschriebene Callback-HTML ist vollständig entfernt.
