---
title: "How to: Lokal entwickeln"
description: Authorization Server, Entwicklungs-Identity-Provider, Demo-API und Doku-Website aus diesem Repository lokal starten.
sidebar:
  label: "How to: Lokal entwickeln"
---

Das Repository läuft als vier lokale Prozesse: Authorization Server mit Administrationsoberfläche, Demo-Expenses-API, passwortloser Entwicklungs-Identity-Provider und diese Doku-Website. Verwende eine Wegwerf-Datenbank, denn der Entwicklungs-Seed schreibt Demo-Daten.

## Voraussetzungen

- macOS oder Linux (WSL2 unter Windows).
- Git und Node.js 24. Die Mindestversion steht in der `package.json` im Repository-Stamm.
- pnpm in der festgelegten `packageManager`-Version. `corepack enable` installiert sie.
- Docker mit laufendem Daemon und [Caddy](https://caddyserver.com/docs/install) für lokales HTTPS.
- Freie Ports 80/443, 3000–3002, 4321 und 5433.

## 1. Installieren und konfigurieren

```sh
git clone https://github.com/seibert-external/weldall.git
cd weldall
pnpm install --frozen-lockfile

# Signaturschlüssel und Secrets. Überschreibt eine vorhandene .env nicht.
(umask 077; set -C; pnpm --silent secrets:generate > .env)
```

Behalte eine vorhandene `.env`: ihre Schlüssel gehören zu deiner Datenbank. `.env.example` listet die Variablen, enthält aber keine nutzbaren Werte.

Starte eine Datenbank, die nur auf localhost lauscht:

```sh
docker run --name weldall-dev-postgres \
  -e POSTGRES_PASSWORD=weldall-development \
  -p 127.0.0.1:5433:5432 \
  -v weldall-dev-postgres:/var/lib/postgresql/data \
  -d postgres:16-alpine
```

Richte `POSTGRES_URL` in der `.env` darauf aus:

```dotenv
POSTGRES_URL=postgresql://postgres:weldall-development@127.0.0.1:5433/postgres
```

Später genügt `docker start weldall-dev-postgres`. Lass `WELDALL_DEPLOYMENT_MODE=development` und `NODE_USE_SYSTEM_CA=1` stehen.

## 2. Datenbank initialisieren

```sh
pnpm db:generate
pnpm --filter @weldall/db build
pnpm --filter @weldall/sdk build
pnpm db:migrate:deploy
pnpm db:seed:development
```

Der Seed schreibt Demo-Ressourcen und -Skills, installiert den Provider „Development login" und schließt das Setup für `alice@example.com` mit Admin- und Login-Scopes ab.

## 3. Stack starten

```sh
# /etc/hosts-Einträge für *.seibert.localdev. Fragt eventuell nach sudo.
sh scripts/setup-hosts.sh

# Terminal 1: lokales HTTPS. `caddy trust` einmal ausführen, falls Browser oder Node die CA ablehnen.
caddy run --config Caddyfile

# Terminal 2
pnpm dev
```

| Anwendung                         | Adresse                             |
| --------------------------------- | ----------------------------------- |
| Administrationsoberfläche und API | `https://weldall.seibert.localdev`  |
| Demo-Expenses-API                 | `https://expenses.seibert.localdev` |
| Entwicklungs-Identity-Provider    | `https://dev-idp.seibert.localdev`  |
| Dokumentation                     | `http://localhost:4321`             |

Öffne `https://weldall.seibert.localdev`, wähle **Development login** und bestätige die vorbelegte Adresse `alice@example.com`. Nur diese Adresse erhält Scopes vom Entwicklungs-Seed. Jede andere `@example.com`-Adresse bekommt ebenfalls eine Sitzung, aber ohne Scopes; damit bleiben Administrationsoberfläche und CLI für sie verschlossen.

:::note
Der Entwicklungs-Identity-Provider ist passwortlos und verifiziert jede eingegebene Adresse. Mach ihn nur auf deiner Maschine erreichbar.
:::

Provider-Callbacks laufen über `https://weldall.seibert.localdev/api/auth/callback/<provider-id>`. Starte die Prozesse nach Änderungen an der `.env` neu; Änderungen an einem Provider in der Administrationsoberfläche wirken sofort.

## 4. Mit der CLI anmelden

```sh
pnpm --filter @weldall/cli build
export NODE_USE_SYSTEM_CA=1
./apps/cli/dist/index.js config set-issuer https://weldall.seibert.localdev
./apps/cli/dist/index.js login
```

Damit ändert sich der Issuer, den die CLI speichert. Stell ihn zurück, bevor du die CLI auf eine andere Installation richtest.

## 5. Echten Installer testen

Für einen Durchlauf durch `/setup` wie bei einer echten Installation nimmst du eine zweite, leere Datenbank. Exportiere ihre URL als `POSTGRES_URL`, führe die Befehle aus Schritt 2 aus und seede mit `pnpm db:seed:production` statt `pnpm db:seed:development`. Trage dann die Werte aus [How to: Weldall aufsetzen](../weldall-setup/) ein: das Setup-Token aus der `.env`, `alice@example.com`, den Issuer `https://dev-idp.seibert.localdev`, `DEV_IDP_CLIENT_ID`, `DEV_IDP_CLIENT_SECRET`, `client_secret_post`, die Scopes `openid profile email` und die Domain `example.com`. Der erste Provider behält die feste Callback-ID `00000000-0000-4000-8000-000000000001`.

## Prüfungen

`pnpm test` schreibt in die Datenbank, auf die es zeigt.

```sh
pnpm format:check
pnpm check
pnpm typecheck
pnpm test
pnpm build:dev
pnpm test:e2e
```

:::note[Testdatenbank]
Exportiere eine Wegwerf-Testdatenbank als `POSTGRES_URL` und migriere und seede sie vor `pnpm test`. Die PostgreSQL-OIDC-Suite braucht zusätzlich `psql` und `OIDC_TEST_SERVER_URL`; sie legt eindeutig benannte Datenbanken an, entfernt sie wieder und wird ohne diese Variable übersprungen. Die CI verlangt sie.
:::

`pnpm test:e2e` startet einen eigenen Docker-Stack mit dem Production-Build von Next. Er braucht weder Caddy noch Änderungen am Trust-Store des Hosts.

## Beenden

Ctrl+C beendet `pnpm dev` und Caddy. `docker stop weldall-dev-postgres` stoppt die Datenbank; das benannte Volume behält seine Daten.

## Nächste Schritte

- [How to: Weldall aufsetzen](../weldall-setup/) — eine Instanz bereitstellen.
- [Doku-Website](https://github.com/seibert-external/weldall/blob/main/apps/docs/README.md) — nur an dieser Website arbeiten.
- [Python SDK](https://github.com/seibert-external/weldall/blob/main/packages/python-sdk/README.md) — nutzt uv statt pnpm.
