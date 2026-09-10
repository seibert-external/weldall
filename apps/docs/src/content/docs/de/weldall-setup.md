---
title: "How to: Weldall aufsetzen"
description: Eine Weldall-Instanz bereitstellen und für die erste Nutzung konfigurieren.
sidebar:
  label: "How to: Weldall aufsetzen"
---

Eine Weldall-Instanz wird als einzelner Container betrieben. Das Repository enthält eine [Dockerfile](https://github.com/seibert-external/weldall/blob/main/Dockerfile), die den Authorization Server und die Administrationsoberfläche zu einem Image baut. Das Image benötigt eine PostgreSQL-Datenbank, eine definierte Menge an Umgebungsvariablen und eine öffentlich erreichbare HTTPS-URL. Sind diese Voraussetzungen erfüllt, ist die Instanz betriebsbereit: Administrationsoberfläche, OAuth-Endpunkte und das erste Administratorkonto entstehen beim Start automatisch.

Diese Seite setzt Grundkenntnisse über Weldall voraus. Das Produkt beschreibt die [Einführung](../).

## Was der Container enthält

Das Image startet den Weldall-Server als eigenständige Next.js-Anwendung. Beim Start werden folgende Schritte ausgeführt:

1. Die Datenbank-Migrationen laufen mit Prisma.
2. Die Produktionsdatenbank wird initialisiert, veröffentlichte Skill-Kataloge werden aktualisiert.
3. Ist eine E-Mail-Adresse konfiguriert, wird das erste Administratorkonto angelegt.
4. Der Server startet auf Port 3000.

Der Container läuft als Nicht-Root-Benutzer und bietet einen Health-Check auf `/.well-known/openid-configuration` an. Damit lässt er sich unmittelbar an die Readiness-Prüfung der Container-Plattform anschließen.

## Voraussetzungen

Vor dem Bau und Start des Images müssen folgende Voraussetzungen erfüllt sein:

- **Eine PostgreSQL-Datenbank** – Weldall speichert Konfiguration und Audit-Einträge in PostgreSQL.
- **Eine öffentliche HTTPS-URL** – Mitarbeitende melden sich über diese URL an; sie muss erreichbar sein und HTTPS verwenden. Dieselbe URL wird für `WELDALL_ISSUER` und für die Login-Weiterleitung verwendet.
- **Ein Google-OAuth-Client** – Die Anmeldung nutzt Google als SSO-Provider. Der Client wird in der Google Cloud Console angelegt; als Redirect-URL wird `<WELDALL_ISSUER>/api/auth/callback/google` eingetragen.
- **Ein Schlüsselpaar zum Signieren** – Weldall signiert seine JWTs (ID-JAGs) mit einem ES256-Schlüsselpaar (P-256).

## Umgebungsvariablen

Fehlt eine Pflichtvariable, bricht der Container den Start ab. Dieses Verhalten ist beabsichtigt: Eine unvollständig konfigurierte Instanz ist nicht betriebsfähig und soll gar nicht erst starten.

| Variable                                                    | Zweck                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| `POSTGRES_URL`                                              | Verbindungszeichenfolge für PostgreSQL.                |
| `WELDALL_ISSUER`                                            | Öffentliche HTTPS-URL der Instanz.                     |
| `BETTER_AUTH_SECRET`                                        | Geheimnis zum Signieren der Browser-Session-Cookies.   |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                  | Der Google-OAuth-Client für die SSO-Anmeldung.         |
| `WELDALL_SIGNING_PRIVATE_JWK`, `WELDALL_SIGNING_PUBLIC_JWK` | Das ES256-Signaturschlüsselpaar als JWK.               |
| `WELDALL_SIGNING_KID`                                       | Schlüssel-ID, die den Signaturschlüssel identifiziert. |

:::note[Signaturschlüssel]
Das ES256-Schlüsselpaar wird einmalig erzeugt und im Secret Manager aufbewahrt. JWKs und Schlüssel-ID müssen stabil bleiben: Ein rotierter Schlüssel würde bereits ausgestellte Identitäts-Assertions entwerten.
:::

Optionale Variablen:

| Variable                            | Zweck                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `WELDALL_BOOTSTRAP_ADMIN_EMAIL`     | E-Mail-Adresse des ersten Administrators, angelegt beim ersten Start.            |
| `WELDALL_CREDENTIAL_ENCRYPTION_KEY` | AES-Schlüssel zum Speichern schreibgeschützter Group-Provider-Zugangsdaten.      |
| `OAUTH_PROXY_SECRET`                | Gemeinsames Geheimnis für den optionalen [Discovery-Proxy](../discovery-proxy/). |
| `LOG_LEVEL`                         | Detailgrad der Logs, Standard ist `INFO`.                                        |

## Bauen und starten

Das Image wird aus der [Dockerfile](https://github.com/seibert-external/weldall/blob/main/Dockerfile) im Repository-Stamm gebaut und anschließend mit der jeweiligen Konfiguration gestartet:

```sh
docker build -t weldall .

docker run -d --name weldall \
  -p 3000:3000 \
  -e POSTGRES_URL=postgresql://user:password@db:5432/weldall \
  -e WELDALL_ISSUER=https://weldall.example.com \
  -e BETTER_AUTH_SECRET=... \
  -e GOOGLE_CLIENT_ID=... \
  -e GOOGLE_CLIENT_SECRET=... \
  -e WELDALL_SIGNING_PRIVATE_JWK='...' \
  -e WELDALL_SIGNING_PUBLIC_JWK='...' \
  -e WELDALL_SIGNING_KID=... \
  -e WELDALL_BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  weldall
```

Der Container lauscht auf Port 3000. Alternativ kann eine Container-Plattform die Dockerfile direkt aus dem Repository bauen; auf diesem Weg wird auch die Produktionsinstanz bereitgestellt.

## Nach dem ersten Start

1. Öffne `https://weldall.example.com` und melde dich mit dem Google-Konto an, das zu `WELDALL_BOOTSTRAP_ADMIN_EMAIL` passt. Der Bootstrap-Schritt vergibt diesem Konto die Administrator-Rolle und den Scope `weldall:login`.
2. In der Administrationsoberfläche werden Scopes angelegt, Ressourcen registriert und Berechtigungen vergeben. Die Vorgehensweise beschreibt [How to: Service integrieren](../service-configuration/).
3. Auf einem Mitarbeiter-Gerät wird die CLI auf die Instanz ausgerichtet und angemeldet:

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
