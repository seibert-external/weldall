# Weldall-Prototyp lokal testen

## 1. Login-Provider auswählen

Für lokale Entwicklung steht ein passwortloser Development-OIDC-Provider zur
Verfügung. Er akzeptiert ausschließlich die in `DEV_IDP_USERS_JSON`
konfigurierten Testidentitäten. Aktiviere ihn mit `ENABLE_DEV_LOGIN=true`.

Google wird zusätzlich angeboten, sobald `GOOGLE_CLIENT_ID` und
`GOOGLE_CLIENT_SECRET` beide gesetzt sind. Für einen Google-Test legst du in der
[Google Cloud Console](https://console.cloud.google.com/auth/clients) einen Web
OAuth Client mit exakt dieser Redirect URI an:

```text
http://localhost:3000/api/auth/callback/google
```

Nur eine der beiden Google-Variablen zu setzen ist ein Konfigurationsfehler. Der
Development-Login wird im Production-Modus grundsätzlich abgelehnt.

## 2. `.env` erzeugen

```bash
pnpm install --frozen-lockfile
pnpm secrets:generate > .env
```

Der Generator erzeugt die vollständige lokale Konfiguration: PostgreSQL,
Development-Login mit `alice@example.com`, Client-Secret sowie die benötigten
Development-IdP-, Weldall- und Expenses-Signing-Keys. Für Google ersetzt du beide
`<<insert or delete line>>`-Platzhalter in `.env`; ohne Google löschst du beide
Zeilen.

## 3. Hosts, Datenbank und Build vorbereiten

```bash
scripts/setup-hosts.sh
pnpm db:generate
pnpm db:migrate:deploy
pnpm --filter @weldall/weldall admin:bootstrap --email alice@example.com
pnpm build:dev
```

Falls Caddys lokale CA noch nicht vertraut wird:

```bash
sudo caddy trust
```

## 4. Dienste starten

Starte die Apps und Caddy in zwei separaten Terminals. Turbo startet Weldall,
Expenses und den Development IdP gemeinsam.

### Terminal 1: Apps

```bash
pnpm dev
```

### Terminal 2: Caddy

```bash
caddy run --config Caddyfile
```

Danach sollten diese URLs erreichbar sein:

- `https://weldall.seibert.localdev/scopes`
- `https://weldall.seibert.localdev/assignments`
- `https://expenses.seibert.localdev/.well-known/oauth-authorization-server`
- `https://dev-idp.seibert.localdev/.well-known/openid-configuration`

## 5. CLI installieren und Login testen

```bash
(cd apps/cli && npm link)
weldall login
```

Der Browser öffnet sich, führt durch den Google-Login und endet beim lokalen CLI-Callback.

Anschließend kannst du die gewährten Scopes prüfen:

```bash
weldall scopes
weldall scopes --resource expenses
```

## 6. Expenses API testen

### Expenses lesen

```bash
weldall request --scope expenses:read \
  https://expenses.seibert.localdev/api/expenses
```

### Expense erstellen

```bash
weldall request --method POST \
  --scope expenses:create \
  --json '{"description":"Train","amount":24}' \
  https://expenses.seibert.localdev/api/expenses
```

### Expense löschen

DELETE demonstriert die All-of-Scope-Prüfung und benötigt beide Scopes:

```bash
weldall request --method DELETE \
  --scope expenses:delete \
  --scope expenses:write \
  https://expenses.seibert.localdev/api/expenses/expense-1
```

## 7. Logout testen

```bash
weldall logout
```

## 8. Hermetische End-to-End-Tests

Mit laufendem Docker-Daemon startet ein Kommando PostgreSQL, den Development
IdP, Weldall, Expenses, Caddy, Chromium und die echte CLI in einem isolierten
Compose-Netz:

```bash
pnpm test:e2e
```

Die Suite erzeugt alle Signing-Keys und Secrets für jeden Lauf neu, installiert
Caddys Test-CA für Node und Chromium, bootstrapped den Administrator, vergibt die
Test-Scopes über die Admin-UI und prüft anschließend Scope Discovery,
DPoP-Request, Logout, Metadaten sowie nicht autorisierte Requests. Console- und Text-Artefakte werden automatisch auf OAuth-Codes, Tokens,
JWTs und private Schlüssel geprüft. Traces und Screenshots sind für den
Authentifizierungsflow deaktiviert; Testartefakte werden standardmäßig entfernt.
Für eine lokale Fehleranalyse können sie bewusst mit
`KEEP_E2E_ARTIFACTS=1 pnpm test:e2e` behalten werden. Container, Volumes,
Datenbank, Keys und Tokens werden anschließend entfernt.
