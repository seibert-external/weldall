# Produktentscheidung: Wo liegen Connector-Credentials?

Wir möchten Agenten einen einheitlichen Zugriff auf Dienste wie Google Calendar, Gmail, Jira, Confluence und HubSpot geben. Bevor wir das Connector-Pattern weiterbauen, müssen wir eine grundlegende Entscheidung treffen:

> Liegen die Provider-Credentials lokal in der Keychain des Nutzers oder zentral bei Weldall beziehungsweise einem extern betriebenen Connector?

Diese Entscheidung bestimmt nicht nur die technische Architektur. Sie entscheidet auch, ob Connections später geteilt, mit Rovo oder auf Mobilgeräten genutzt und zentral verwaltet werden können.

## So sieht der Unterschied für den Nutzer aus

### Lokales Credential, direkter Request

```sh
weldall request \
  --connection mein-google \
  https://www.googleapis.com/calendar/v3/calendars/primary/events
```

Die CLI holt vor dem Request eine kurze Lease von Weldall. Damit prüft Weldall, ob Nutzer, Connection und Ziel zu diesem Zeitpunkt erlaubt sind. Das Google-Credential liegt in der lokalen Keychain und die CLI spricht anschließend direkt mit Google. Die Lease kontrolliert damit die offizielle CLI, verhindert aber nicht, dass ein ausgelesenes Access-Token an Weldall vorbei direkt beim Anbieter verwendet wird.

### Zentrales Credential, Request über einen Connector

```sh
weldall request \
  --connection mein-google \
  https://weldallhost.com/connectors/google/calendar/v3/calendars/primary/events
```

Das Credential liegt in der Weldall-Datenbank oder später in der Datenbank eines externen Connectors. Weldall beziehungsweise der Connector führt den Request zum Anbieter aus.

## Warum wir diese Entscheidung jetzt brauchen

Heute richten Mitarbeitende für einzelne Dienste lokale CLIs oder MCP-Server ein und speichern Tokens auf ihren Rechnern. Mit der zentral ausgerollten Weldall CLI können wir daraus einen einheitlichen Ablauf machen: `weldall login`, einmaliger OAuth-Flow und danach ein gleiches Request-Pattern für alle unterstützten Dienste (zum Beispiel Google Calendar, Gmail, Jira, Confluence oder HubSpot).

Offen ist, welchen Teil davon Weldall zentral übernimmt. Beide Varianten lösen das heutige Einrichtungsproblem. Sie führen aber zu unterschiedlichen Produkten.

## Vergleich

|                         | Lokale Keychain + Lease                                                                                         | Connector-Pattern                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Datenweg**            | CLI spricht direkt mit dem Anbieter                                                                             | Requests und Antworten laufen über den Connector                                                                      |
| **Credential-Speicher** | Auf dem Gerät des Nutzers                                                                                       | Verschlüsselt bei Weldall oder einem externen Connector                                                               |
| **Widerruf**            | Weldall kann neue Leases stoppen, das lokale Provider-Token aber nicht verlässlich löschen oder ungültig machen | Der Connector besitzt das Credential und kann Refresh, Rotation und den Widerruf beim Provider zentral ausführen      |
| **Nutzung**             | Persönlich und an das eingerichtete Gerät gebunden                                                              | Auch für Sharing, Mobilgeräte, Rovo und serverseitige Agenten geeignet                                                |
| **Audit und Policies**  | Weldall sieht die Lease, aber nicht zuverlässig, welcher Provider-Request tatsächlich ausgeführt wurde          | Der Connector kann bestimmte Requests zentral protokollieren oder verbieten, etwa das massenhafte Löschen von E-Mails |
| **Risiko**              | Weniger zentrale Secrets, dafür verteilte Credentials auf Endgeräten                                            | Zentraler Token-Store mit größerem Schadenspotenzial und höheren Schutzanforderungen                                  |
| **Betrieb**             | Weniger zentrale Infrastruktur                                                                                  | Zusätzliche Verantwortung für Verschlüsselung, Verfügbarkeit, Updates und Incident Response                           |

## Konsequenzen der Nutzung einer lokalen Keychain

Ein Provider-Token ist weiterhin ein Bearer-Credential (ein Access-Token beziehungsweise ein Refresh-Token). Wer es aus der Keychain auslesen kann, kann es auch außerhalb der Weldall CLI verwenden. Wenn die IT in der Admin-UI eine Connection trennt, kann Weldall zwar sofort weitere Leases verweigern. Das bereits lokal ausgegebene Token wird dadurch beim Provider jedoch nicht automatisch ungültig.

Auch die lokale Bereinigung ist nicht garantiert: Das Gerät kann offline, verloren oder nicht mehr in Benutzung sein. Selbst wenn die CLI ihren Keychain-Eintrag löscht, ist damit nicht bewiesen, dass keine Kopie des Tokens existiert. Ein verlässlicher Widerruf erfordert Zugriff auf das Provider-Credential und eine entsprechende Unterstützung durch den Anbieter. Diese Kontrolle liegt bei der lokalen Variante nicht zentral vor.

## Auswirkung auf Weldall als Produkt

Mit lokalen Credentials bauen wir in erster Linie eine einheitliche, kontrollierte CLI für persönliche Accounts. Das ist ein kleinerer zentraler Verantwortungsbereich und hält die eigentlichen Provider-Requests aus Weldall heraus.

Mit zentralen Credentials bauen wir eher eine Integrationsplattform. Dieses Modell nutzen auch Anbieter wie Composio oder OpenWork. Erst dieses Modell ermöglicht die kontrollierte Nutzung eines Accounts durch mehrere Personen und über alternative Clients wie Rovo, mobile Apps oder Background-Jobs (auf anderen Servern). Dafür übernimmt Weldall deutlich mehr Verantwortung und wird Teil des kritischen Datenwegs.

Insbesondere folgende Ziele lassen sich mit ausschließlich lokalen Credentials nicht sinnvoll erreichen:

- Accounts kontrolliert mit anderen Personen oder Gruppen teilen,
- dieselbe Connection auf dem Handy oder ohne das ursprüngliche Gerät verwenden,
- Rovo beziehungsweise alternative Agenten unabhängig von einer Nutzer-CLI ausführen,
- Credentials zentral rotieren und ihren Widerruf nachvollziehen,
- Provider-Requests vollständig auditieren oder feiner als die Provider-API einschränken.

## Mögliche erste Dienste

- **Google Calendar:** technisch bereits erprobt und ein guter erster End-to-End-Fall.
- **Gmail:** ähnlich integrierbar, aber wegen der sensibleren Daten und Tokens ein wichtiger Sicherheitstest.
- **Jira Cloud und Confluence Cloud:** OAuth ist vorhanden; zusätzlich ist zu prüfen, ob REST oder ein offizielles Remote-MCP besser passt.

## Zur Entscheidung

Ich habe beide Varianten prototypisch implementiert. Beides funktioniert. Wir sollten uns für einen Weg entscheiden:

1. **Dezentrale Connections:** Credentials bleiben lokal, Weldall autorisiert ihre Nutzung per Lease.
2. **Verwaltete Connections:** Credentials liegen zentral, Requests laufen über Weldall oder später über einen externen, kundenbetriebenen Connector.
