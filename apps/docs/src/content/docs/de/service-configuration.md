---
title: "How to: Unternehmensservice integrieren"
description: Einen Service mit dem TypeScript- oder Python-SDK absichern, in Weldall registrieren und einen Skill veröffentlichen.
sidebar:
  label: Registrierung
---

Ein Mitarbeiter bittet seinen Agenten, Verträge aufzulisten. Der Service soll sie nur zurückgeben, wenn der Mitarbeiter die nötige Berechtigung hat. Das SDK prüft den Request, bevor der Service Daten liest. Ein Skill zeigt dem Agenten den passenden Befehl:

```sh
weldall request --scope contracts:read https://contracts.example.com/api/contracts
```

Applikationsentwickler sichern die Route ab und veröffentlichen den Skill. Weldall-Administratoren registrieren den Service und vergeben Berechtigungen.

## 1. Service entwickeln

Wähle die Anleitung für die Sprache deines Service:

- [TypeScript](./typescript/): Entwickle den Vertragsservice mit Hono und `@weldall/sdk`. Die Seite verlinkt auch die Beispiele für Fetch, Next.js und Astro auf GitHub.
- [Python](./python/): Entwickle denselben Service mit FastAPI und `weldall-sdk`, oder verwende das Django-Beispiel auf GitHub.

Beide Anleitungen verwenden die Registrierungswerte auf dieser Seite. Du benötigst eine laufende Weldall-Instanz und einen Administratorzugang. Falls Weldall noch nicht läuft, beginne mit [How to: Weldall aufsetzen](../weldall-setup/).

## Für Weldall-Administratoren

Sobald der Service über HTTPS erreichbar ist, öffne die Administrationsoberfläche deiner Weldall-Instanz.

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
| Discover skills      | aktiviert                           |

Die Werte müssen zur Konfiguration im Service passen. Weldall gibt keine Zugangsdaten oder Request-Daten an URLs außerhalb der registrierten Präfixe weiter.

### 3. Skill Discovery prüfen

Öffne **Skills** und prüfe, ob `contracts.list` aus der Resource `contracts` angezeigt wird. Weldall setzt den Resource-Key vor den lokalen Skill-Identifier `list`.

### 4. Berechtigung zuweisen

Weise dem Testnutzer `weldall:login` und `contracts:read` zu. Verwende **Assignments** für seine E-Mail-Adresse oder **Group assignments** für eine passende Provider-Gruppe. Weise `weldall:login` vor der ersten CLI-Anmeldung zu; Weldall vergibt den Scope nicht automatisch über den Identity Provider.

### 5. Integration testen

Melde dich auf dem Gerät des Testnutzers an und prüfe den veröffentlichten Skill:

```sh
weldall login
weldall skills
weldall skills show contracts.list
```

Führe den Request aus dem Skill aus:

```sh
weldall request \
  --scope contracts:read \
  https://contracts.example.com/api/contracts
```

Der Service liefert die Vertragsliste und die Identität, für die Weldall den Request autorisiert hat.

Entferne die effektive Berechtigung `contracts:read` des Testnutzers und prüfe erneut. Weldall blendet den Skill aus und stellt keine neue Autorisierung für diesen Scope aus. Ein bereits ausgestelltes Access Token kann bis zu seinem Ablauf gültig bleiben. Token-Laufzeiten und das Verhalten beim Entzug von Berechtigungen beschreibt die Seite [Sicherheit](../oauth-security/).
