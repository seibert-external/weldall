# Machine-to-Machine-Authentifizierung über Weldall

## Problem

Die Weldall-CLI unterstützt derzeit primär Menschen und lokal laufende Agenten. Sie authentisieren sich interaktiv über den einzigen öffentlichen Client `weldall-cli` und handeln anschließend im Kontext des angemeldeten Benutzers.

Künftig soll auch Anwendungscode sicher auf andere Anwendungen zugreifen können, zum Beispiel **Expenses A → Expenses B**, ohne interaktiven Login und ohne einen menschlichen Benutzer zu simulieren. Weldall soll dafür als zentraler Identity Provider bzw. Authorization Server dienen.

## Ziel

Ein sicheres Machine-to-Machine-Modell entwerfen und umsetzen, mit dem sich Workloads bei Weldall als eigene Identitäten authentisieren und zielgerichtete, kurzlebige Access Tokens für andere Services erhalten können.

Dabei müssen Maschinenidentitäten, menschliche Benutzer und delegierte Benutzerzugriffe klar voneinander unterscheidbar bleiben.

## Anwendungsfälle

### Service handelt als eigene Identität

Expenses A greift aus einem Backend-Prozess auf Expenses B zu:

```text
Expenses A ── authentisiert sich ──▶ Weldall
Expenses A ◀── Access Token für B ── Weldall
Expenses A ── Access Token ────────▶ Expenses B
```

Das Token repräsentiert **Expenses A**, nicht einen Entwickler, Deployment-Benutzer oder Endnutzer.

### Service handelt im Auftrag eines Benutzers

Ein Service empfängt später einen Benutzerkontext und ruft damit einen Downstream-Service auf. Dieser Fall benötigt Delegation bzw. Token Exchange und darf nicht stillschweigend mit Client Credentials vermischt werden.

Diese Variante kann eine spätere Ausbaustufe sein, muss in der Architektur aber berücksichtigt werden.

### Automatisierung und CI

CI-Jobs, Cronjobs und andere nicht-interaktive Workloads benötigen ebenfalls eine eigene Identität, klar begrenzte Scopes und eine sichere Credential-Verteilung.

## Zu entscheidende Architektur

### Token-Aussteller

Folgende Modelle vergleichen und die Entscheidung dokumentieren:

1. **Weldall stellt Access Tokens direkt aus:** Zielservices vertrauen Weldalls Signaturschlüsseln und validieren `iss`, `aud`, Ablaufzeit und Scopes.
2. **Broker-Modell:** Weldall stellt eine Assertion bzw. einen Grant aus; der Authorization Server des Zielservices tauscht ihn gegen ein lokales Access Token.
3. **Hybrid:** Direkte Tokens für einfache interne Services, Broker/Token Exchange für Services mit eigener Authorization Domain.

Es ist insbesondere zu klären, wie sich M2M in den bestehenden ID-JAG- und JWT-DPoP-Flow einfügt und ob dieser für reine Service-Identitäten vereinfacht werden kann.

### Authentisierung der Workload

Mögliche Verfahren:

- `private_key_jwt` mit einem pro Workload registrierten Schlüsselpaar,
- gegenseitiges TLS (mTLS),
- föderierte Workload-Identitäten, z. B. aus Kubernetes oder einer Cloud-Plattform,
- für ein eng begrenztes MVP ein Client Secret mit definierter Rotation.

Langfristig sollten langlebige, kopierbare Client Secrets vermieden werden. Credentials dürfen nicht in Ressource-Manifeste oder das Repository eingecheckt werden.

### OAuth-Flow

Für den Fall „Service handelt als sich selbst“ liegt der Client-Credentials-Grant nahe:

```http
POST /api/oauth/token
Content-Type: application/x-www-form-urlencoded

 grant_type=client_credentials
 &client_id=expenses-a
 &resource=https://expenses-b.example.com
 &scope=expenses-b:read
```

Die genaue Client-Authentisierung wird separat übertragen, z. B. als signiertes `private_key_jwt`. Der Server muss Audience/Resource und Scopes strikt gegen die registrierte Policy prüfen.

Für delegierte Benutzerzugriffe ist stattdessen OAuth Token Exchange zu prüfen. Ein M2M-Client darf nicht allein durch Client Credentials beliebige Benutzer impersonieren.

## Identitäts- und Berechtigungsmodell

- Jede Anwendung erhält eine stabile, eindeutige Client- bzw. Workload-Identität.
- Menschliche Benutzer und Workloads verwenden unterschiedliche Subject Namespaces und Token-Claims.
- Ressourcen definieren, welche Scopes sie unterstützen.
- Eine separate Policy definiert, welche Workload welche Scopes für welche Ressource erhalten darf.
- Die Registrierung eines Clients oder Scopes erzeugt keine automatische Berechtigung.
- Tokens sind an genau die angeforderte Zielressource gebunden (`aud`/`resource`).
- Der Zielservice autorisiert anhand der Service-Identität und Scopes; ein gültiges Token allein bedeutet nicht Vollzugriff.
- Optional müssen Grants Bedingungen wie Umgebung, Tenant oder Deployment-Identität berücksichtigen können.

Beispiel einer statischen MVP-Policy:

```yaml
apiVersion: weldall.dev/v1alpha1
kind: WorkloadClient
metadata:
  name: expenses-a
spec:
  authentication:
    method: private_key_jwt
    jwksUri: https://expenses-a.example.com/.well-known/jwks.json
  grants:
    - resource: expenses-b
      scopes:
        - expenses-b:read
        - expenses-b:create
```

Das konkrete Manifestformat ist mit der Aufgabe zur Ressourcenregistrierung abzustimmen. Private Schlüssel oder Client Secrets sind darin nicht erlaubt.

## Token-Anforderungen

Ein M2M-Token sollte mindestens eindeutig und validierbar abbilden:

- Weldall als Issuer (`iss`),
- die Workload als Subject (`sub`) und/oder autorisierten Client (`client_id`/`azp`),
- genau den Zielservice als Audience (`aud`),
- gewährte Scopes,
- kurze Gültigkeit sowie `iat`, `exp` und `jti`,
- gegebenenfalls eine Schlüsselbindung über DPoP oder mTLS (`cnf`),
- eine eindeutige Unterscheidung zwischen Workload-, Benutzer- und delegierten Tokens.

Claims und Semantik müssen dokumentiert werden, damit Zielservices keine unsicheren Annahmen treffen.

## Sicherheitsanforderungen

- Kein interaktiver Benutzer-Refresh-Token für M2M-Zugriffe.
- Keine Verwendung des öffentlichen Clients `weldall-cli` für Serveranwendungen.
- Clients können nur vorab erlaubte Scopes für vorab erlaubte Ressourcen erhalten.
- Client-Authentisierung, Grant-Prüfung und Audience-Bindung erfolgen serverseitig.
- Access Tokens sind kurzlebig; langfristige Credentials sind rotierbar und widerrufbar.
- Schlüssel-IDs, Rotation und Überlappungszeiträume werden unterstützt.
- Replay-Schutz und Sender Constraining über DPoP oder mTLS werden bewertet.
- Token, Assertions und Secrets werden weder geloggt noch in Fehlermeldungen ausgegeben.
- Client-Anlage, Grant-Änderungen, Token-Ausstellung und Widerruf sind auditierbar.
- Ein kompromittierter Client darf keine fremde Identität annehmen oder Tokens für nicht freigegebene Audiences erhalten.
- SSRF-Risiken bei `jwksUri` und automatischer Metadaten-Discovery werden berücksichtigt.

## MVP-Vorschlag

- Statisch konfigurierte vertrauliche Workload-Clients und Grants.
- Client-Credentials-Grant für „Service handelt als sich selbst“.
- Bevorzugt `private_key_jwt`; alternativ ein klar als vorläufig dokumentiertes Client Secret.
- Kurzlebige, audience-gebundene JWT Access Tokens.
- Validierung im Zielservice über eine gemeinsame OAuth-Middleware.
- Eine Beispielkommunikation Expenses A → Expenses B als Integrationstest.
- Noch keine Benutzer-Impersonation und kein delegierter Benutzerkontext.

## Spätere Ausbaustufen

- Self-Service-Registrierung über eine abgesicherte Admin-API bzw. `weldall up`.
- Workload Identity Federation für Kubernetes und Cloud-Plattformen.
- OAuth Token Exchange für explizite On-Behalf-Of-Szenarien.
- Automatische Schlüsselrotation, Client-Deaktivierung und Notfall-Widerruf.
- Feingranulare Grant-Verwaltung nach Umgebung, Tenant oder Organisation.
- Observability für ausgestellte Tokens und abgelehnte Zugriffe, ohne sensible Tokeninhalte zu speichern.

## Akzeptanzkriterien

- Die Entscheidung zwischen direkt ausgestellten Tokens, Broker-Modell und Hybrid ist dokumentiert.
- Expenses A kann sich ohne menschlichen Login als eigene Workload authentisieren.
- Expenses A erhält ausschließlich ein kurzlebiges Token für Expenses B und die explizit erlaubten Scopes.
- Expenses B validiert Issuer, Audience, Ablauf, Workload-Identität und Scopes.
- Nicht erlaubte Scopes, eine falsche Audience, ungültige Client-Credentials und Replay-Versuche werden abgelehnt.
- Das Token ist eindeutig als Workload-Token erkennbar und kann nicht mit einem Benutzer-Token verwechselt werden.
- Der bestehende interaktive CLI-Flow funktioniert unverändert weiter.
- Credentials können rotiert bzw. ein Client kann deaktiviert werden.
- Ein End-to-End-Test deckt erfolgreichen und abgelehnten Zugriff von Expenses A auf Expenses B ab.
- Grenzen und Folgeaufgaben für delegierten Benutzerzugriff sind dokumentiert.
