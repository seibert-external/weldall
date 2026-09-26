---
title: "How to: Weldall aufsetzen"
description: Eine Weldall-Instanz bereitstellen und für die erste Nutzung konfigurieren.
sidebar:
  label: "How to: Weldall aufsetzen"
---

Eine Weldall-Instanz wird als einzelner Container betrieben. Das Repository enthält eine [Dockerfile](https://github.com/seibert-external/weldall/blob/main/Dockerfile), die den Authorization Server und die Administrationsoberfläche zu einem Image baut. Das Image benötigt eine PostgreSQL-Datenbank, eine definierte Menge an Umgebungsvariablen und eine öffentlich erreichbare HTTPS-URL. Sind diese Voraussetzungen erfüllt, liefert die Instanz den Web-Installer aus: Er bindet deinen Identity Provider an und legt das erste Administratorkonto an. [How to: Installer ausführen](../installer/) beschreibt den Ablauf.

Diese Seite setzt Grundkenntnisse über Weldall voraus. Das Produkt beschreibt die [Einführung](../).

## Was der Container enthält

Das Image startet den Weldall-Server als eigenständige Next.js-Anwendung. Beim Start werden folgende Schritte ausgeführt:

1. Die Datenbank-Migrationen laufen mit Prisma.
2. Die Produktionsdatenbank wird initialisiert, veröffentlichte Skill-Kataloge werden aktualisiert.
3. Der Server startet auf Port 3000 und liefert den Installer unter `/setup` aus, bis eine Installation abgeschlossen ist.

Der Container läuft als Nicht-Root-Benutzer und bietet einen Health-Check auf `/.well-known/openid-configuration` an. Damit lässt er sich unmittelbar an die Readiness-Prüfung der Container-Plattform anschließen.

## Voraussetzungen

Vor dem Bau und Start des Images müssen folgende Voraussetzungen erfüllt sein:

- **Eine PostgreSQL-Datenbank** – Weldall speichert Konfiguration und Audit-Einträge in PostgreSQL.
- **Eine öffentliche HTTPS-URL** – Mitarbeitende melden sich über diese URL an; sie muss erreichbar sein und HTTPS verwenden. Dieselbe URL wird für `WELDALL_ISSUER` und für die Login-Weiterleitung verwendet.
- **Ein zentraler Identity Provider** – Weldall hat keine lokalen Konten; Mitarbeitende melden sich über den IdP deines Unternehmens an. Jeder OIDC-Provider passt. Der Installer fragt nach seinem Issuer und einem Client, siehe [How to: Installer ausführen](../installer/).
- **Ein Schlüsselpaar zum Signieren** – Weldall signiert seine JWTs (ID-JAGs) mit einem ES256-Schlüsselpaar (P-256).

## Umgebungsvariablen

Fehlt eine Pflichtvariable, bricht der Container den Start ab. Dieses Verhalten ist beabsichtigt: Eine unvollständig konfigurierte Instanz ist nicht betriebsfähig und soll gar nicht erst starten.

| Variable                                                    | Zweck                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| `POSTGRES_URL`                                              | Verbindungszeichenfolge für PostgreSQL.                |
| `WELDALL_ISSUER`                                            | Öffentliche HTTPS-URL der Instanz.                     |
| `BETTER_AUTH_SECRET`                                        | Geheimnis zum Signieren der Browser-Session-Cookies.   |
| `WELDALL_SIGNING_PRIVATE_JWK`, `WELDALL_SIGNING_PUBLIC_JWK` | Das ES256-Signaturschlüsselpaar als JWK.               |
| `WELDALL_SIGNING_KID`                                       | Schlüssel-ID, die den Signaturschlüssel identifiziert. |

:::note[Signaturschlüssel]
Das ES256-Schlüsselpaar wird einmalig erzeugt und im Secret Manager aufbewahrt. JWKs und Schlüssel-ID müssen stabil bleiben: Ein rotierter Schlüssel würde bereits ausgestellte Identitäts-Assertions entwerten.
:::

Für den Installer nötig:

| Variable                            | Zweck                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `WELDALL_SETUP_TOKEN`               | Base64url-Token aus mindestens 32 Zufallsbytes, das das Setup autorisiert.       |
| `WELDALL_CREDENTIAL_ENCRYPTION_KEY` | Base64-kodierter 32-Byte-AES-Schlüssel, der Provider-Zugangsdaten verschlüsselt. |

Der erste Start braucht beide: ohne sie bleibt der Installer geschlossen.

Optionale Variablen:

| Variable    | Zweck                                |
| ----------- | ------------------------------------ |
| `LOG_LEVEL` | Log-Verbosität, Standard ist `INFO`. |

## Secrets erzeugen

Signaturschlüssel und Secrets erzeugt das Repository:

```sh
pnpm install --frozen-lockfile
pnpm secrets:generate
```

Der Befehl gibt Umgebungszeilen für den gesamten Workspace aus. Für den Container übernimmst du `WELDALL_SIGNING_PRIVATE_JWK`, `WELDALL_SIGNING_PUBLIC_JWK`, `WELDALL_SIGNING_KID`, `BETTER_AUTH_SECRET`, `WELDALL_SETUP_TOKEN` und `WELDALL_CREDENTIAL_ENCRYPTION_KEY` in deinen Secret Manager. `POSTGRES_URL` und `WELDALL_ISSUER` setzt du selbst.

:::note[Entwicklungseinträge]
Lass den Rest der Ausgabe weg: `WELDALL_DEPLOYMENT_MODE=development`, `NODE_USE_SYSTEM_CA`, `DEV_IDP_*`, `EXPENSES_*` und `DEV_M2M_*` gehören zum lokalen Entwicklungsstack. Der Container verlangt `WELDALL_DEPLOYMENT_MODE=production` und startet mit keinem anderen Wert.
:::

## Bauen und starten

Das Image wird aus der [Dockerfile](https://github.com/seibert-external/weldall/blob/main/Dockerfile) im Repository-Stamm gebaut und anschließend mit der jeweiligen Konfiguration gestartet:

```sh
docker build -t weldall .

docker run -d --name weldall \
  -p 3000:3000 \
  -e POSTGRES_URL=postgresql://user:password@db:5432/weldall \
  -e WELDALL_ISSUER=https://weldall.example.com \
  -e BETTER_AUTH_SECRET=... \
  -e WELDALL_SETUP_TOKEN=... \
  -e WELDALL_CREDENTIAL_ENCRYPTION_KEY=... \
  -e WELDALL_SIGNING_PRIVATE_JWK='...' \
  -e WELDALL_SIGNING_PUBLIC_JWK='...' \
  -e WELDALL_SIGNING_KID=... \
  weldall
```

Der Container lauscht auf Port 3000. Alternativ kann eine Container-Plattform die Dockerfile direkt aus dem Repository bauen; auf diesem Weg wird auch die Produktionsinstanz bereitgestellt.

## Installer ausführen

Öffne `https://weldall.example.com`. Solange keine Installation abgeschlossen ist, zeigt Weldall den Installer: Er fragt nach dem Operator-Setup-Token, dem ersten Administrator und einem OIDC-Client. [How to: Installer ausführen](../installer/) erklärt jedes Feld, die Callback-URL und den optionalen Testlogin.

Der Installer braucht `WELDALL_SETUP_TOKEN` und `WELDALL_CREDENTIAL_ENCRYPTION_KEY`. Ohne sie bleibt die Seite geschlossen und nennt die fehlenden Variablen.

Der Installer speichert den Provider, legt den ersten Administrator mit `weldall:administer` und `weldall:login` an und schließt sich endgültig.

## Nach der Installation

1. Lege in der Administrationsoberfläche Scopes an, registriere Ressourcen und vergib Berechtigungen. Die Vorgehensweise beschreibt [How to: Service integrieren](../service-configuration/).
2. Richte die CLI auf einem Mitarbeiter-Gerät auf die Instanz aus und melde dich an:

```sh
weldall config set-issuer https://weldall.example.com
weldall login
```

:::note
Weldall vergibt `weldall:login` niemals automatisch vom Identity Provider. Der Scope wird Benutzern vor der ersten CLI-Anmeldung zugewiesen.
:::

## Nächste Schritte

- Eigene Services mit dem SDK absichern: [How to: Service integrieren](../service-configuration/).
- Einstellungen, Scopes, Ressourcen und Zuweisungen als Code verwalten: [Infrastructure as Code](../infrastructure-as-code/).
- Den Sicherheitsablauf der Instanz nachvollziehen: [Sicherheit](../oauth-security/).
