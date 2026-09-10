---
title: "How to: Weldall aufsetzen"
description: Weldall bereitstellen, den einmaligen OIDC-Installer abschließen und Login-Provider verwalten.
sidebar:
  label: "How to: Weldall aufsetzen"
---

Weldall läuft als einzelner [Container](https://github.com/seibert-external/weldall/blob/main/Dockerfile) mit PostgreSQL und einer öffentlichen HTTPS-Origin. Beim Start laufen additive Prisma-Migrationen, die Produktionsinitialisierung und die Aktualisierung veröffentlichter Skill-Kataloge. Next.js startet auf Port 3000. Ein Administrator wird **nicht** automatisch angelegt: Ohne Login-Provider steht der geschützte einmalige Installer bereit. Downstream-Discovery und Maschinen-Authentifizierung bleiben providerunabhängig.

## Voraussetzungen und Geheimnisse

- Eine gesicherte PostgreSQL-Datenbank und eine stabile öffentliche Origin, etwa `https://weldall.example.com`.
- Ein vertrauenswürdiger OIDC-Provider mit Authorization Code, PKCE S256, signierten RS256/ES256/EdDSA-ID-Tokens und stabilem Subject. Das signierte ID-Token muss `email` und den booleschen Claim `email_verified: true` enthalten; Weldall ruft kein UserInfo ab und ergänzt keine unsignierten Identitätsclaims. Reines OAuth reicht nicht.
- HTTPS-Issuer, Client-ID und Client-Secret. Die **vom Installer angezeigte, serverseitig erzeugte Callback-URL** muss vor dem Test beim Provider registriert werden; keine erfundene Provider-ID und kein localhost-Callback.

| Laufzeitvariable                                                                   | Zweck                                                                                                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_URL`                                                                     | PostgreSQL-Verbindungszeichenfolge.                                                                                              |
| `WELDALL_ISSUER`                                                                   | Öffentliche HTTPS-Origin; Callback-URLs stammen nie aus dem Request-Host-Header.                                                 |
| `BETTER_AUTH_SECRET`                                                               | Signaturschlüssel für Browser-Cookies.                                                                                           |
| `WELDALL_SIGNING_PRIVATE_JWK`, `WELDALL_SIGNING_PUBLIC_JWK`, `WELDALL_SIGNING_KID` | Stabiles ES256-JWK-Schlüsselpaar und Schlüssel-ID für Downstream-JWTs.                                                           |
| `WELDALL_CREDENTIAL_ENCRYPTION_KEY`                                                | Kanonisch Base64-codierter AES-Schlüssel mit 32 Byte für OIDC-Zugangsdaten/Versuche, Group-Provider-Tokens und Chat-API-Keys.    |
| `WELDALL_SETUP_TOKEN`                                                              | Nur serverseitiges Operator-Token, Base64url aus mindestens 32 zufälligen Byte; nur bis zum Installationsabschluss erforderlich. |
| `WELDALL_DEPLOYMENT_MODE`                                                          | In Produktion auf `production` setzen; Entwicklungs-IdPs nie öffentlich betreiben.                                               |

Credential-Schlüssel und Setup-Token müssen **unterschiedlich** sein. Den vorhandenen `WELDALL_CREDENTIAL_ENCRYPTION_KEY` wiederverwenden; nur erzeugen, wenn noch keiner existiert:

```sh
openssl rand -base64 32                         # WELDALL_CREDENTIAL_ENCRYPTION_KEY (nur wenn nicht vorhanden)
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' # WELDALL_SETUP_TOKEN
```

Den Verschlüsselungsschlüssel stabil halten und getrennt von der Datenbank sichern. Ein verlorener oder ersetzter Schlüssel macht Provider-Secrets unlesbar; automatische Rotation/Wiederherstellung ist nicht vorgesehen. Cookie-Secret und Setup-Token nicht als Credential-Schlüssel wiederverwenden. Geheimnisse gehören nie in URLs, Logs oder Browser-Storage. Nach Abschluss das Setup-Token aus den Laufzeit-Secrets entfernen; abgeschlossene Installation lässt sich damit nicht wieder öffnen.

`WELDALL_CREDENTIAL_ENCRYPTION_KEY_VERSION` ist standardmäßig `1` für Group-Provider- und Chat-Credential-Envelopes; die Variable rotiert den Schlüssel nicht automatisch. `LOG_LEVEL` ist standardmäßig `INFO`. Datenbank- oder Migrationsfehler sind Dienstfehler und öffnen niemals den Installer.

## Bauen und starten

Der Build benötigt weder erreichbare Datenbank/IdP noch Provider-Secrets, Setup-Token oder Credential-Verschlüsselungsschlüssel. Laufzeit-Secrets über die Container-Plattform bereitstellen, nicht im Image speichern:

```sh
docker build -t weldall .
# Vom Operator verwaltete Datei, nur für ihren Besitzer lesbar:
docker run --name weldall --env-file /secure/weldall-runtime.env -p 3000:3000 weldall
```

HTTPS am vertrauenswürdigen Proxy terminieren und an Port 3000 weiterleiten. Der Health-Check `/.well-known/openid-configuration` prüft nicht die Erreichbarkeit eines Upstream-Providers. Der Produktions-Seed lässt eine frische Installation uninitialisiert; Entwicklungs-Seeds gehören nicht in Produktion.

## Einmalige Installation

1. `https://weldall.example.com/setup` öffnen. `/` und `/login` leiten bis zum Abschluss dorthin um; CLI-Autorisierung liefert `setup_required`.
2. Operator-Token, E-Mail des ersten Administrators und Provider-Konfiguration eingeben: Verbindung, Button, Scopes und optional erlaubte E-Mail-Domains. Die angezeigte Callback-URL upstream registrieren. Issuer-Schreibweise und Discovery müssen exakt übereinstimmen; HTTPS-Issuer mit Pfad und eine explizite Discovery-URL sind möglich. `client_secret_basic` oder `client_secret_post` entsprechend dem Provider wählen. `openid` und `email` sind Pflicht, `offline_access` ist upstream verboten.
3. Die Identitätsautorität bestätigen: Verifizierte E-Mail ist **eine Behauptung des Providers**, kein unabhängiger Nachweis. Eine leere Domain-Liste vertraut allen verifizierten Adressen; Domain-Grenzen machen einen bösartigen Provider nicht sicher.
4. Optional **Test login (optional)** wählen, um die Konfiguration auf eigene Verantwortung in einem neuen Tab auszuprobieren. Der an Operator-Token und Browser gebundene Test prüft die nominierte verifizierte E-Mail und meldet Erfolg oder Fehler. Er erstellt keinen Provider, User, Account, Grant, keine Session, keinen Audit-Eintrag, Installationsabschluss oder Testverlauf. Popups erlauben; trennt der Provider den Opener ab, das Ergebnis im Test-Tab lesen. Die Konfiguration bleibt ausschließlich im Arbeitsspeicher des ursprünglichen Formulars, nie im Browser-Speicher; Änderungen verwerfen den Teststatus.
5. Zum Abschluss **Complete installation** wählen – ohne vorherigen Test oder auch nach einem fehlgeschlagenen Test. Dies startet eine **eigene** OIDC-Anmeldung mit der nominierten E-Mail; ein früheres Testergebnis autorisiert keinen Abschluss. Discovery, Signatur, Issuer/Audience, Nonce, PKCE, aktuelle verifizierte E-Mail und Domain-Prüfung müssen erfolgreich sein.
6. Erst diese passende Anmeldung aktiviert transaktional den ersten Provider, erhält oder erstellt die Weldall-User-ID, ergänzt `weldall:login` und `weldall:administer`, schreibt Audit und schließt Setup dauerhaft ab. Erst danach entsteht die Admin-Session; offene Setup- und Setup-Test-Versuche werden entfernt.

Die Callback-URL wird einmal pro Installation vergeben und bleibt über Neuladen, Tabs, lange Konfigurationsphasen und Provider-Aktivierung hinweg identisch. Das Öffnen des Formulars startet keinen Anmeldeversuch und benötigt kein Entwurfs-Cookie. Erst ein Button-Klick startet einen einmaligen, browsergebundenen OIDC-Versuch mit zehn Minuten Laufzeit. Entfernen oder Ändern des Operator-Tokens macht offene Versuche ungültig. Abbruch, falsche E-Mail, abgelaufene/wiederholte Versuche, Konflikte und fehlerhafter Austausch vergeben keine Admin-Rechte. Erneut über `/setup` versuchen. Abgeschlossenes Setup öffnet sich nie wieder, auch nicht bei ausschließlich deaktivierten Providern. Bei Änderungen eine bestehende Admin-Session offen halten.

## Provider live verwalten

Als Weldall-Administrator `/admin/login-providers` öffnen. Hinzufügen, bearbeiten, aktivieren/deaktivieren und Reihenfolge setzen funktionieren ohne Neustart. ID und Issuer bleiben unveränderlich; eine andere Autorität erfordert einen neuen Provider. Client-Secrets sind nur schreibbar: Beim Bearbeiten leer lassen, um das bestehende Secret zu behalten. Deaktivierte Provider verschwinden aus `/login`, Identitätsbindungen und Audit bleiben erhalten. Maximal 100 Provider sind möglich.

**Test login** verwendet in einem neuen Tab die aktuellen, auch ungespeicherten Formularwerte. Nur ein kurzlebiger verschlüsselter, an Browser und Admin-Session gebundener Versuch wird verbraucht. Kein Provider, User, Link, Grant, keine neue Session, kein Audit und keine Testhistorie entstehen. Auch eine andere Testidentität ersetzt die Admin-Session nicht. Zum Formular für das Ergebnis zurückkehren. Popups erlauben; trennt die Browser-Isolationsrichtlinie eines Providers den Opener ab, das Ergebnis im Test-Tab lesen und bei Bedarf erneut testen.

Vor dem Speichern testen. Änderungen verwerfen den Teststatus, verspätete Ergebnisse alter Formulare werden ignoriert. **Speichern bleibt die ausdrückliche Verantwortung des Administrators**, ohne gespeicherten Erfolgsnachweis als technische Voraussetzung. Saves sind adminautorisiert, CSRF-geschützt, versioniert und atomar auditiert; bei veralteter Version neu laden. Anlegen, Reaktivieren sowie Änderungen an Verbindung, Zugangsdaten oder Identitätsautorität benötigen Discovery-Preflight. Deaktivieren, Umordnen und reine Darstellungsänderungen bei unveränderter Autorität bleiben während eines IdP-Ausfalls möglich; der bisherige Validierungszeitpunkt bleibt dann bestehen.

Jeder aktivierte Save benötigt eine neue Vertrauensbestätigung. Der letzte aktive Provider darf nur nach zusätzlicher Lockout-Warnung deaktiviert werden. Das kann neue Logins verhindern, setzt aber Setup nicht zurück. Änderungen widerrufen **keine** bestehenden Sessions, CLI-Refresh- oder Downstream-Access-Tokens. Laufende normale Login-Versuche scheitern bei geänderter Provider-Version.

OIDC vergibt normalen Benutzern keine Weldall-Berechtigungen. `weldall:login` vor der ersten CLI-Autorisierung und Ressourcen-Scopes separat zuweisen. Upstream-Rollen/Gruppen gewähren keine Scopes. Dieselbe normalisierte verifizierte E-Mail verschiedener vertrauenswürdiger Issuer bindet an dieselbe User-ID. Mehrdeutige Bestandsadressen, unverifizierte lokale Konten und geänderte E-Mail bestehender Bindungen scheitern statt stillschweigend zusammengeführt zu werden. Upstream-Access-/Refresh-Tokens werden nicht gespeichert.

Alle vier Abläufe verwenden `openid-client` für Upstream-Autorisierung, PKCE, vollständige Callback-Prüfung, Token-Austausch und signierte ID-Token-/JWKS-Verifikation. Weldall behält Provider-Policy, verschlüsselte browsergebundene Einmalversuche, Identitätsbindung und Installationstransaktionen. Better Auth erstellt lokale Sessions erst nach erfolgreichem Anwendungsabschluss. Upstream-Tokens werden weder an Routen zurückgegeben noch gespeichert.

Discovery-/Token-/JWKS-Requests verwenden verifiziertes HTTPS, keine Redirects, strikte JSON-Medientypen, ein gestreamtes Antwortlimit von 256 KiB und acht Sekunden Timeout pro Request einschließlich Body (nicht für den gesamten Login). Private HTTPS-Ziele bleiben erlaubt. Es gibt **keine anwendungsseitige Ziel-/DNS-Filterung oder SSRF-Abwehr**; bei Bedarf Egress im Deployment begrenzen. Discovery muss die exakte Issuer-Schreibweise und die konfigurierte Client-Authentifizierung unterstützen. Feste Routing-Querys sind erlaubt; reservierte Protokollparameter in Endpoint-URLs werden abgelehnt statt repariert.

Client-Konfigurationen werden erst bei Bedarf initialisiert und fünf Minuten gecacht (maximal 100 Einträge, nach Konfiguration/Zugangsdaten getrennt). Fehlgeschlagene Initialisierung wird verworfen; Verfügbarkeits-/Versionsprüfungen bleiben unabhängig vom Cache. Die Bibliothek hält JWKS fünf Minuten vor und erlaubt bei unbekannten Schlüsseln nach einer Minute erneutes Laden. Neue Schlüssel vor ihrer Nutzung veröffentlichen und alte während des Übergangs beibehalten; ein sofortiger Wechsel kann Logins vorübergehend scheitern lassen. Ein defekter Provider blockiert weder andere Provider noch neutrale Downstream-Endpunkte.

## Bestehende Installation umstellen (Operator-Aufgabe)

Dies ist eine bewusste Breaking Change. Zuerst mit einer **Datenbankkopie** proben. Anwendung und Migration erledigen die folgenden Widerrufsschritte nicht automatisch:

1. Datenbank, stabile Signatur-/Cookie-Secrets und Credential-Schlüssel sichern. User-IDs, Grants, Bindungen, Browser-/CLI-Autorisierung erfassen. Nominierte Admin-E-Mail gegen die echte verifizierte Identität und normalisierte Bestandsduplikate prüfen.
2. **Alle alten Instanzen** drainen und neue Browser-/CLI-Autorisierung stoppen. Vorhandenen Credential-Schlüssel und Setup-Token bereitstellen; öffentliche Origin beibehalten.
3. Alte Browser- und CLI-Autorisierung explizit widerrufen. `Session`, `OauthRefreshToken` einschließlich Rotation-Replay-Zustand, benutzerbezogene `OauthAccessToken`, `OAuthDeviceRefreshBinding` und offene Authorization-Code-Einträge in `Verification` gezielt mit Operator-Werkzeugen prüfen. Keine User, Grants, Geschäftsdaten, Maschinen oder unbeteiligten Verification-Daten pauschal löschen. Cookie-Secret-Rotation allein widerruft keine CLI-Refresh-Tokens.
4. Bereits ausgestellte eigenständige JWTs/ID-JAGs und Downstream-Service-Tokens separat berücksichtigen: Offline-Verifier erkennen keine gelöschten Datenbankzeilen. Die **maximale konfigurierte Lebensdauer aller Downstream-Dienste** abwarten oder Schlüsselstilllegung samt JWKS-/Verifier-Cache-Invalidierung koordinieren. DB-Widerruf ist kein sofortiger globaler Logout.
5. Neues Image deployen. Prisma ergänzt Installations-/Provider-/Versuchszustand und löscht ausschließlich `Account` mit `providerId='google' AND issuer='https://accounts.google.com'`, einschließlich Tokens auf diesen Zeilen. User-IDs, Verifizierung, Grants, Sessions, andere Bindungen und Geschäftsdaten bleiben erhalten. Alte Migrationen bleiben unverändert; kein Ersatzprovider wird importiert.
6. Alte Google-Zugangsdaten, Dev-Login-Flags, Bootstrap-Admin-E-Mail und OAuth-Proxy-Secrets/-Konfiguration entfernen. Alten Erstadmin-Befehl, Google-Button/-Preset, Runtime-Dev-Zweig und localhost-Callback gibt es nicht mehr. Produktion liest keine Dev-Variablen als Provider-Quelle.
7. Health und Setup-Verhalten prüfen, Installer abschließen, erhaltene Admin-ID/Grants kontrollieren, zusätzliche Provider testen und Browser-/CLI-Autorisierung prüfen. Externen alten Google-OAuth-Client und Upstream-Secrets separat stilllegen, nachdem andere Nutzer dieses Clients ausgeschlossen wurden. Account-Bereinigung widerruft keinen externen Client.
8. Traffic erst nach Prüfung der widerrufenen alten Refresh-/Code-Flows und des neuen OIDC-Logins öffnen. Setup-Token entfernen. Backup-/Rollback-Verfahren im Wartungsplan halten; eine alte DB-Wiederherstellung stellt auch alte Autorisierung wieder her.

## Nächste Schritte

- [Service integrieren](../service-configuration/) und Ressourcen-Scopes zuweisen.
- [Infrastructure as Code](../infrastructure-as-code/) für unterstützte Ressourcen/Zuweisungen; Login-Provider werden bewusst nur über die UI verwaltet.
- [Sicherheit](../oauth-security/) zum unveränderten Downstream-OAuth-/DPoP-Vertrag.
- [Lokale Entwicklung](https://github.com/seibert-external/weldall/blob/main/docs/development.md) mit gewöhnlich konfigurierten OIDC-Fixtures und echtem Installer.
