# Connector V1 Checklist

## Umfang

- [ ] Nur Connector-Typ `google`
- [ ] Gmail und Google Calendar
- [ ] Keine Materialisierung von Google-Daten
- [ ] Nur Primitive `PersonalConnection` mit lokalen Credentials
- [ ] Kein generisches `credentialMode`-Feld oder SharedConnection-Platzhalter

## Administration

- [ ] Mehrere Google-Connectoren
- [ ] Konfiguration über Admin-UI und API
- [ ] Keine IaC-Unterstützung
- [ ] OAuth-Client-Secret verschlüsselt in PostgreSQL
- [ ] Gmail- und Calendar-Scopes konfigurierbar

## Admin-UI

- [ ] tRPC mit TanStack Query
- [ ] Formulare mit TanStack Form
- [ ] Listen mit TanStack Table
- [ ] URL-Zustand mit `nuqs`
- [ ] Query-Invalidierung und Operation-Toasts
- [ ] Versionsprüfung bei Änderungen
- [ ] Installationsweite Connection-Liste
- [ ] Connection-Filter und Pagination
- [ ] Serverseitiger Disconnect ohne Abhängigkeit von einer erreichbaren CLI

## Connections

- [ ] Eigenständige Modelle `PersonalConnection` und `PersonalConnectionAuthorization`
- [ ] Verpflichtender Besitzer und verbundenes Gerät
- [ ] Provider-Operationen und `OAuthCredentials` unabhängig vom persönlichen Lifecycle
- [ ] Mehrere Google-Accounts pro Nutzer und Connector
- [ ] Bestätigte Google-Account-ID
- [ ] Zentrale Connection-Metadaten
- [ ] Tokens ausschließlich in der lokalen Keychain
- [ ] Connect, Reconnect und Disconnect

## Audit-Log

- [ ] Connector-Änderungen
- [ ] Connection-Lebenszyklus
- [ ] Credential-Refreshes
- [ ] Lease-Ergebnisse
- [ ] Keine Secrets oder Request-Inhalte

## Requests

- [ ] `weldall request -c <connection> <url>`
- [ ] Direkte Requests von der CLI zu Google
- [ ] Kurzlebige Connection Leases
- [ ] Feste Gmail- und Calendar-Ziele
- [ ] Keine Redirects
- [ ] Geschützte Transport-Header
- [ ] Unveränderte Google-Antworten

## Nicht Teil von V1

- [ ] Keine SharedConnections (später eigenes Datenmodell, eigene Grants und Backend-Ausführung)
- [ ] Kein Connection Sharing und kein Umwandeln einer PersonalConnection in SharedConnection
- [ ] Keine Service Accounts
- [ ] Keine Background-Jobs
- [ ] Keine externen Connector-Dienste
- [ ] Kein Connector-HTTP-Protokoll
- [ ] Keine weiteren Provider
