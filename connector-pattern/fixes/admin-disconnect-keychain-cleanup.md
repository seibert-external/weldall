# Fix: Lokale Credentials nach Admin-Disconnect bereinigen

## Problem

Ein Administrator kann eine `PersonalConnection` serverseitig löschen, während die zugehörigen Google-Credentials weiterhin in der Keychain des verbundenen Geräts liegen.

Die serverseitige Sicherheit bleibt erhalten: Ohne `PersonalConnection` stellt Weldall keine neue Connection Lease aus. Die lokale Bereinigung funktioniert derzeit aber nur in einem schmalen Race:

1. Die CLI lädt die Connection erfolgreich.
2. Ein Administrator löscht sie.
3. Die anschließende Lease-Anfrage erhält `not_found`.
4. Erst dann löscht die CLI den Keychain-Eintrag.

Startet der Nutzer die CLI erst nach dem Admin-Disconnect, scheitert bereits das Laden der Connection. Die CLI kennt dann in diesem Ablauf keine Connection-ID mehr und der Keychain-Eintrag bleibt dauerhaft liegen. Auch `weldall connections list` gleicht lokale Credentials derzeit nicht mit dem autoritativen Serverzustand ab.

### Zusätzliches Problem: Credentials sind nicht Login-scoped

Lokale Connection-Credentials werden aktuell nur über `issuer + connectionId` adressiert. Der Weldall-`subject` des Besitzers ist weder Teil des Keychain-Schlüssels noch des gespeicherten Credential-Formats. Meldet sich auf demselben Betriebssystemkonto ein anderer Weldall-Nutzer an, schützt der Server zwar weiterhin Listing, Lookup und Lease über `ownerId`; die lokalen Credentials beider Nutzer liegen aber im selben issuer-weiten Namensraum.

Das ist **nicht gewollt**. Insbesondere darf ein Abgleich für Nutzer B niemals lokale Credentials von Nutzer A als vermeintlich verwaist löschen. Ebenso soll die lokale Credential-Zuordnung die serverseitige Besitzergrenze ausdrücklich abbilden, statt sich nur auf die nicht erratbare Connection-ID zu verlassen.

## Ziel

`weldall connections` beziehungsweise `weldall connections list` bereinigt verwaiste lokale Connection-Credentials deterministisch und best effort. Der Server bleibt die Autorität darüber, welche PersonalConnections existieren und verwendet werden dürfen.

## Vorgeschlagene Lösung

Nach einer **vollständig erfolgreichen** Abfrage von `GET /api/me/connections` führt die CLI einen einfachen Abgleich aus:

1. Alle lokalen `personal-connection-*`-Einträge für den aktuellen Issuer **und den aktuell eingeloggten Subject** auflisten.
2. Nur deren gespeicherte Connection-IDs mit den IDs der Serverantwort vergleichen.
3. Lokale Einträge löschen, deren ID nicht mehr auf dem Server existiert.
4. Fehler beim Löschen als Warnung ausgeben, ohne die erfolgreich geladene Connection-Liste zu verwerfen.

Es darf keine Bereinigung stattfinden, wenn die Serverabfrage fehlschlägt, die Antwort ungültig ist oder nicht garantiert vollständig ist. Falls die API später paginiert wird, muss der Abgleich erst nach dem Laden aller Seiten laufen.

Die Keychain-Abstraktion erhält dafür genau eine kleine Operation, beispielsweise:

```ts
personalConnectionKeychain.list(issuer, subject): Promise<Array<{ connectionId: string }>>
```

Neue Credentials werden mit `issuer`, `subject` und `connectionId` gespeichert und über diese drei Werte adressiert. Die Implementierung kann die Credentials des CLI-Service auflisten, auf `personal-connection-*` beschränken, den gespeicherten `issuer` und `subject` prüfen und nur validierte Connection-Einträge zurückgeben. Session-Einträge sowie Connections anderer Issuer oder Nutzer bleiben unberührt. Da V1 noch nicht veröffentlicht ist, sollte das Format direkt korrigiert werden statt eine unnötige Kompatibilitätsschicht für das ungeeignete Format einzuführen.

## Disconnect vereinfachen

V1 sollte für PersonalConnections keine scheinbar zuverlässige Provider-Revocation versprechen. Der aktuelle Nutzer-Disconnect sendet das lokale Refresh Token an Weldall, damit der Server nach dem Löschen best effort einen Google-Widerruf versucht. Dieser Pfad ist beim Admin-Disconnect und bei einer nicht erreichbaren CLI grundsätzlich nicht verfügbar und erzeugt zwei unterschiedliche Disconnect-Semantiken.

Der einfachere Vertrag lautet deshalb:

- Nutzer- und Admin-Disconnect löschen die PersonalConnection und verhindern sofort neue Leases und Refreshes über Weldall.
- Ein Nutzer-Disconnect löscht anschließend den bekannten lokalen Keychain-Eintrag.
- `weldall connections` bereinigt später Einträge, die durch Admin-Disconnect oder andere serverseitige Löschungen verwaist sind.
- Der Disconnect-Endpunkt nimmt kein lokales Provider-Token mehr entgegen und meldet keinen `providerRevocation`-Status mehr.
- Audit-Metadaten versprechen keinen Provider-Widerruf.

Die nur für Disconnect verwendete best-effort Revocation kann damit entfallen. Ein etwaiger kompensierender Widerruf für Tokens aus einem fehlgeschlagenen OAuth-Handoff ist davon getrennt und kann bestehen bleiben.

Diese Vereinfachung muss in der CLI-Dokumentation klar benennen: Weldall sperrt die Verwendung über die offizielle CLI, kann ein bereits lokal ausgegebenes Google-Token aber nicht zentral ungültig machen. Falls ein vollständiger Provider-Widerruf erforderlich ist, erfolgt er über die Account-Verwaltung des Providers.

## Betroffene Stellen

- `apps/cli/src/storage/keychain.ts`: Credentials nach `issuer + subject + connectionId` adressieren und nutzerbegrenzt auflisten.
- `apps/cli/src/services/connectors.ts`: Abgleich nach erfolgreichem `listConnections`; vereinfachter Disconnect.
- `apps/weldall/src/app/api/me/connections/[selector]/disconnect/route.ts`: Token aus dem Request entfernen.
- `apps/weldall/src/server/connectors/personal-connection-service.ts`: Disconnect ohne Provider-Revocation und Statusfeld.
- Connector- und CLI-Vertragsdokumentation: einheitliche Disconnect-Semantik beschreiben.

## Akzeptanzkriterien

- Nach Admin-Disconnect entfernt der nächste erfolgreiche Aufruf von `weldall connections` den verwaisten Keychain-Eintrag.
- Ein fehlgeschlagener oder unvollständiger List-Aufruf löscht keine lokalen Credentials.
- Credentials anderer Issuer, anderer Weldall-Nutzer und normale Session-Einträge werden nie entfernt.
- Ein Loginwechsel zeigt oder löscht keine lokalen Connection-Credentials des vorherigen Nutzers.
- Ein Nutzer-Disconnect entfernt weiterhin unmittelbar seinen lokalen Eintrag.
- Disconnect überträgt kein Refresh Token an Weldall und versucht keinen Provider-Widerruf.
- Eine gelöschte Connection erhält unabhängig von der lokalen Bereinigung keine Lease.
