# Weldall CLI: Login, DPoP und ID-JAG

## Geltungsbereich

Dieses Dokument ist der maßgebliche Implementierungsplan für eine lokal
installierte Weldall CLI auf den Rechnern von Mitarbeitern.

Die CLI ist ein **öffentlicher nativer OAuth-Client**. Sie besitzt kein zwischen
Installationen geteiltes Client Secret und keinen zentral erzeugten Client
Private Key.

Die wesentlichen CLI-Kommandos sind:

```text
weldall login     Mitarbeiter über Weldall und CSG anmelden
weldall scopes    effektive Berechtigungen des angemeldeten Mitarbeiters anzeigen
weldall request   ID-JAG und Downstream Access Token beschaffen und eine API aufrufen
```

Die konkrete Syntax für Request Body, Parameter und Response-Rendering liegt
außerhalb des Geltungsbereichs dieses Dokuments. Der Sicherheits- und
Protokollablauf von `weldall request` ist verbindlich definiert.

---

## 1. Beteiligte Systeme

```text
┌──────────────────────┐
│ Weldall CLI           │
│ auf Mitarbeitergerät │
│ Public OAuth Client  │
└──────────┬───────────┘
           │
           │ Browser-Login, PKCE, DPoP
           ▼
┌─────────────────────────────┐       ┌──────────────────────┐
│ Weldall                      │──────►│ CSG                  │
│ IdP Authorization Server    │       │ Mitarbeiter-Login    │
│ zentrale Policy + ID-JAG    │◄──────│ MFA / SSO            │
└──────────────┬──────────────┘       └──────────────────────┘
               │
               │ bei `weldall request`:
               │ von Weldall signierter, zielgebundener ID-JAG
               ▼
┌─────────────────────────────┐
│ Expenses Authorization      │
│ Server                      │
│ Resource AS                 │
└──────────────┬──────────────┘
               │
               │ Expenses Access Token
               ▼
┌─────────────────────────────┐
│ Expenses API                │
│ Resource Server             │
│ z. B. GET /api/expenses     │
└─────────────────────────────┘
```

Es gibt zwei Authorization Server mit unterschiedlichen Aufgaben:

| System                        | Aufgabe                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ |
| Weldall                       | Mitarbeiter authentifizieren, zentrale Policy auswerten, ID-JAG ausstellen     |
| Expenses Authorization Server | ID-JAG validieren, lokalen Benutzer auflösen, Expenses Access Token ausstellen |
| Expenses API                  | Expenses Access Token und DPoP-Proof validieren, Fachautorisierung durchführen |

Weldall ist aus Sicht der Expenses-Anwendung der vorgelagerte IdP Authorization
Server. Der Expenses Authorization Server ist der Resource Authorization Server
der Zielanwendung.

---

## 2. Schlüssel und ihre Besitzer

```text
Weldall Signing Keypair
└── Weldall Private Key
    ├── signiert Weldall Access Tokens
    ├── signiert Weldall ID Tokens
    └── signiert ID-JAGs

Expenses Signing Keypair
└── Expenses AS Private Key
    └── signiert Expenses Access Tokens

Per-Install DPoP Keypair
└── Private Key auf dem Mitarbeitergerät
    └── signiert DPoP-Proofs der CLI
```

### 2.1 Öffentlicher CLI-Client

Eine lokale CLI kann kein vertrauliches Client Secret sicher halten. Ein Secret
oder Private Key, das in jede Installation kopiert wird, wäre nach der ersten
Installation kein Geheimnis mehr.

Für die CLI gelten deshalb diese Anforderungen:

```text
kein geteiltes Client Secret
kein zentral erzeugter CLI Private Key
kein Device Private Key in einer Projekt-.env
keine manuelle Schlüsselverteilung an Mitarbeiter
```

### 2.2 Per-Install DPoP Key

Bei der ersten Anmeldung erzeugt jede Installation selbst ein ES256-Keypair:

```text
Julians MacBook  → Device Key A
Julians Desktop  → Device Key B
Alices MacBook   → Device Key C
```

Der Private Key:

- verlässt das Gerät nicht,
- wird nicht an Weldall übertragen,
- wird nicht in einer Projekt-`.env` gespeichert,
- liegt im Betriebssystem-Keychain,
- wird für jeden DPoP-Proof verwendet.

Der Public Key wird in einem DPoP-Proof mitgesendet. Er ist kein Secret.

Ein DPoP Key macht die CLI nicht zu einem vertraulichen Client. Er beweist nicht
„diese Software ist die zentrale Weldall-Anwendung“, sondern:

> Dieser Request stammt von derselben Installation, an deren Key die Tokens
> gebunden wurden.

---

## 3. Thumbprint und `cnf.jkt`

Aus dem Device Public Key wird ein RFC-7638-JWK-Thumbprint gebildet:

```text
kanonischer Public JWK
          │
          ▼
       SHA-256
          │
          ▼
     Base64URL
          │
          ▼
       cnf.jkt
```

Ein gebundener Access Token enthält nicht den vollständigen Public Key, sondern
nur dessen Thumbprint:

```json
{
  "sub": "weldall-user-123",
  "cnf": {
    "jkt": "thumbprint-des-device-public-keys"
  }
}
```

Der vollständige Public Key steht im Header des aktuellen DPoP-Proofs:

```json
{
  "typ": "dpop+jwt",
  "alg": "ES256",
  "jwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "...",
    "y": "..."
  }
}
```

Der empfangende Server:

1. verifiziert den DPoP-Proof mit dem enthaltenen Public Key,
2. berechnet dessen Thumbprint,
3. vergleicht ihn mit `cnf.jkt` im Token.

Der Thumbprint dient primär dem Vergleich, nicht dem Nachschlagen des Public
Keys. Der Public Key muss deshalb nicht pro Installation in jeder API registriert
werden.

### 3.1 Warum der vollständige Public Key im Proof stehen darf

Der Public Key ist kein Secret. Ein DPoP-Proof enthält ihn, damit der empfangende
Server die Proof-Signatur unmittelbar prüfen kann. Der Private Key bleibt im
Keychain und wird niemals übertragen.

Der Public Key im Proof ist für sich allein noch nicht vertrauenswürdig. Ein
Angreifer könnte ein eigenes Keypair erzeugen, seinen Public Key mitsenden und
einen formal gültigen Proof signieren. Die Token-Bindung verhindert diesen
Key-Austausch:

```text
DPoP-Proof
├── enthält Device Public Key
└── ist mit zugehörigem Device Private Key signiert
          │
          ▼
Proof-Signatur gültig
→ Absender besitzt irgendeinen passenden Private Key

vertrauenswürdiger Token
└── enthält cnf.jkt des erlaubten Device Public Keys
          │
          ▼
Thumbprint(Public Key aus Proof) == Token cnf.jkt
→ Absender besitzt genau den Private Key, an den der Token gebunden ist
```

Ein Angreifer-Key erzeugt einen anderen Thumbprint:

```text
Angreifer Public Key
        │
        ▼
anderer JWK Thumbprint
        │
        ▼
passt nicht zu Token cnf.jkt
        │
        ▼
Request ablehnen
```

Die Form des `cnf` Claims ist in
[RFC 7800](https://www.rfc-editor.org/rfc/rfc7800.html) definiert. Die
DPoP-Bindung über `cnf.jkt` beschreibt
[RFC 9449 §6.1](https://www.rfc-editor.org/rfc/rfc9449.html#section-6.1). Die
Berechnung des kanonischen JWK-Thumbprints folgt
[RFC 7638](https://www.rfc-editor.org/rfc/rfc7638.html).

### 3.2 Warum `cnf.jkt` vertrauenswürdig ist

`cnf.jkt` ist nur vertrauenswürdig, weil es Bestandteil eines vom zuständigen
Issuer signierten Tokens oder Grants ist. Die JWS-Signatur schützt den gesamten
JWT Payload und damit auch den Thumbprint gegen Veränderungen. JWS ist in
[RFC 7515](https://www.rfc-editor.org/rfc/rfc7515.html) definiert.

Beim ID-JAG schützt Weldall die Bindung:

```text
ID-JAG Payload
├── iss = Weldall
├── sub = Weldall User
├── aud = Expenses AS
├── scope = expenses:read
└── cnf.jkt = Device-Key-Thumbprint
          │
          ▼
JWS-Signatur mit Weldall Private Key
```

Die Expenses AS prüft zuerst die Weldall-Signatur mit einem Public Key aus
Weldalls JWKS. Erst nach erfolgreicher Signaturprüfung darf sie `cnf.jkt`
verwenden. Eine Änderung des Thumbprints macht die Signatur ungültig.

Beim Expenses Access Token übernimmt die Expenses AS dieselbe Device-Bindung und
schützt sie mit ihrer eigenen Signatur:

```text
Weldall-signierter ID-JAG
└── cnf.jkt = Device-Key-Thumbprint
          │
          │ ID-JAG + passender DPoP-Proof
          ▼
Expenses Authorization Server
          │
          ▼
Expenses-AS-signierter Access Token
└── cnf.jkt = derselbe Device-Key-Thumbprint
```

Beim API-Request prüft die Expenses API deshalb zwei unabhängige Signaturen und
deren Bindung:

```text
Expenses Access Token
└── Signatur mit Expenses-AS-Public-Key prüfen

DPoP-Proof
└── Signatur mit Public Key aus dem Proof prüfen

Bindung
└── Thumbprint(Public Key aus Proof) == Access Token cnf.jkt
```

Die resultierende Vertrauenskette lautet:

```text
Weldall
├── vertraut der über CSG bestätigten Benutzeridentität
├── validiert den Device-Proof
└── signiert ID-JAG einschließlich cnf.jkt

Expenses Authorization Server
├── vertraut Weldalls Signatur
├── validiert erneut den Device-Proof
└── signiert Expenses Access Token einschließlich cnf.jkt

Expenses API
├── vertraut der Signatur der Expenses AS
└── validiert den Device-Proof für den konkreten API-Request
```

Die DPoP-Regeln für Proof-Signatur, `jwk`, `htm`, `htu`, `ath`, `iat` und `jti`
stehen in [RFC 9449 §4](https://www.rfc-editor.org/rfc/rfc9449.html#section-4).
Die Bindung eines ID-JAGs an einen DPoP-Key beschreibt der
[ID-JAG Draft §9.8](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-identity-assertion-authz-grant-04#section-9.8).

---

## 4. Inhalt eines DPoP-Proofs

Jeder DPoP-Proof ist an genau einen aktuellen HTTP-Request gebunden.

```json
{
  "htm": "GET",
  "htu": "https://expenses.example/api/expenses",
  "ath": "hash-des-access-tokens",
  "iat": 1770000000,
  "jti": "eindeutige-proof-id"
}
```

| Claim | Bedeutung                            |
| ----- | ------------------------------------ |
| `htm` | HTTP-Methode des aktuellen Requests  |
| `htu` | Ziel-URI des aktuellen Requests      |
| `ath` | Hash des mitgesendeten Access Tokens |
| `iat` | Erstellungszeitpunkt des Proofs      |
| `jti` | eindeutige ID zur Replay-Erkennung   |

`htm` und `htu` sind in jedem DPoP-Proof vorhanden, auch an Token Endpoints, an
denen noch kein API Access Token existiert. `ath` wird benötigt, wenn der Proof
zusammen mit einem Access Token an eine Resource API gesendet wird.

Diese Claims bestimmen nicht die fachliche Berechtigung. Dafür sind insbesondere
`aud`, `resource`, `scope` und gegebenenfalls `authorization_details` im Token
zuständig.

```text
aud / resource / scope  → Was darf der Token grundsätzlich?
htm / htu               → Für welchen aktuellen Request gilt der Proof?
ath                     → Welcher Access Token gehört zu diesem Proof?
iat / jti               → Ist der Proof aktuell und noch nicht verwendet?
```

---

## 5. Zusammenspiel von DPoP, ID-JAG und JWT-DPoP

Die drei Begriffe beschreiben unterschiedliche Ebenen des Ablaufs:

| Mechanismus    | Aufgabe                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| DPoP           | Besitz des Device Private Keys für einen konkreten HTTP-Request beweisen                   |
| ID-JAG         | Von Weldall signierte Berechtigung, bei einer Resource AS einen Access Token zu beantragen |
| JWT-DPoP Grant | Einen bereits DPoP-gebundenen JWT Grant unter erneutem Key-Nachweis einlösen               |

Ein DPoP-Proof ist technisch ebenfalls ein signierter JWT. Der Name
**JWT-DPoP Grant** bezeichnet jedoch nicht den Proof selbst, sondern den OAuth
Grant Type `urn:ietf:params:oauth:grant-type:jwt-dpop`, mit dem ein
DPoP-gebundener JWT wie der ID-JAG eingelöst wird.

### 5.1 DPoP

DPoP ist ein allgemeiner OAuth-Mechanismus zur Senderbindung. Die CLI signiert
für jeden geschützten Request einen neuen DPoP-Proof mit ihrem Device Private Key.

DPoP entscheidet nicht, welche Scopes der Benutzer besitzt. Es beweist:

> Der Absender dieses Requests besitzt den Private Key, an den das verwendete
> Token oder der verwendete Grant gebunden ist.

DPoP kann unabhängig von ID-JAG verwendet werden, beispielsweise beim
Authorization-Code- oder Refresh-Token-Request an Weldall.

### 5.2 ID-JAG

Der ID-JAG ist ein von Weldall signierter JWT Authorization Grant:

```json
{
  "iss": "https://weldall.example",
  "sub": "weldall-user-123",
  "aud": "https://expenses.example/oauth",
  "client_id": "weldall-cli-at-expenses",
  "resource": "https://expenses.example/api",
  "scope": "expenses:read",
  "jti": "one-time-grant-id",
  "iat": 1770000000,
  "exp": 1770000300
}
```

Der ID-JAG ist kein Access Token für die Expenses API. Er erlaubt der CLI nur,
bei der Expenses Authorization Server einen Expenses Access Token zu beantragen.

Ohne Key-Bindung wird ein ID-JAG als JWT Bearer Grant eingelöst:

```http
grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
&assertion=<id-jag>
```

Ein solcher Grant ist gegenüber dem Device ein Bearer-artiges Credential. Kurze
Lebensdauer, Zielbindung und Replay-Schutz begrenzen das Risiko, beweisen aber
nicht den Besitz eines bestimmten Device Keys.

### 5.3 DPoP-gebundener ID-JAG

Sendet die CLI beim ID-JAG-Request an Weldall einen DPoP-Proof, bindet Weldall den
ID-JAG an dessen Public-Key-Thumbprint:

```text
CLI Device Key
      │
      │ DPoP-Proof
      ▼
Weldall /oauth/token
      │
      │ berechnet Thumbprint des Proof-Public-Keys
      ▼
ID-JAG
└── cnf.jkt = Device-Key-Thumbprint
```

Der ID-JAG enthält dann zusätzlich:

```json
{
  "cnf": {
    "jkt": "device-key-thumbprint"
  }
}
```

Damit erklärt Weldall:

> Dieser ID-JAG darf nur von einem Client eingelöst werden, der den zu
> `cnf.jkt` gehörenden Device Private Key besitzt.

### 5.4 JWT-DPoP Grant

Der JWT-DPoP Grant ist das Einlöseverfahren für einen DPoP-gebundenen JWT Grant.
Die CLI sendet den ID-JAG und einen neuen DPoP-Proof an die Expenses AS:

```http
POST https://expenses.example/oauth/token
DPoP: <proof-signed-by-device-key>
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-dpop
&assertion=<id-jag>
```

Die Expenses AS prüft:

```text
Weldall-Signatur des ID-JAG                         ✓
ID-JAG aud = Expenses AS                           ✓
ID-JAG client_id = Client bei der Expenses AS      ✓
ID-JAG resource und scope lokal erlaubt            ✓
ID-JAG jti gültig und nicht verbraucht             ✓
DPoP-Proof für POST auf Expenses Token Endpoint    ✓
Thumbprint(Public Key aus Proof) == ID-JAG cnf.jkt ✓
```

Nur wenn beide Seiten der Key-Bindung zusammenpassen, stellt die Expenses AS den
Access Token aus. Dieser wird an denselben Device Key gebunden:

```json
{
  "token_type": "DPoP",
  "access_token": "<expenses-access-token>"
}
```

Der Access Token enthält beziehungsweise referenziert:

```json
{
  "iss": "https://expenses.example/oauth",
  "aud": "https://expenses.example/api",
  "scope": "expenses:read",
  "cnf": {
    "jkt": "device-key-thumbprint"
  }
}
```

### 5.5 Verwendung an der API

Beim API-Aufruf verwendet die CLI den von der Expenses AS ausgestellten Access
Token und einen weiteren, request-spezifischen DPoP-Proof:

```http
GET https://expenses.example/api/expenses
Authorization: DPoP <expenses-access-token>
DPoP: <proof-signed-by-device-key>
```

Die Expenses API verifiziert:

```text
Expenses-AS-Signatur des Access Tokens                 ✓
Access Token aud und scope                              ✓
DPoP-Proof-Signatur                                     ✓
Thumbprint(Public Key aus Proof) == Access Token cnf.jkt ✓
Proof ath == SHA-256 des Expenses Access Tokens         ✓
Proof htm und htu passen zum API-Request                ✓
Proof iat und jti sind aktuell und nicht wiederverwendet ✓
```

### 5.6 Gesamtkette

```text
1. DPoP bei Weldall
   CLI ── DPoP-Proof ──► Weldall
   Weldall ── ID-JAG mit cnf.jkt ──► CLI

2. JWT-DPoP bei der Expenses AS
   CLI ── ID-JAG + DPoP-Proof ──► Expenses AS
   Expenses AS ── DPoP Access Token mit cnf.jkt ──► CLI

3. DPoP an der Expenses API
   CLI ── Access Token + DPoP-Proof mit ath ──► Expenses API
```

```text
ID-JAG
= Weldall erlaubt den Downstream-Zugriff.

DPoP
= Die CLI beweist den Besitz des gebundenen Device Keys.

JWT-DPoP
= Die CLI löst einen key-gebundenen JWT Grant unter diesem Nachweis ein.
```

DPoP funktioniert ohne ID-JAG. ID-JAG kann ohne DPoP über `jwt-bearer`
verwendet werden. Der JWT-DPoP Grant verbindet beide Mechanismen für die
sendergebundene Einlösung eines ID-JAGs.

---

## 6. `weldall login`

### 6.1 Ziel

`weldall login` meldet einen Mitarbeiter interaktiv über Weldall und CSG an. Die
CLI verwendet Authorization Code mit PKCE und einen Loopback Redirect gemäß dem
Native-App-Muster.

Die CLI benötigt dabei kein Client Secret.

### 6.2 Ablauf

```text
┌──────────────┐                              ┌──────────────────────┐
│ Weldall CLI   │                              │ Weldall               │
│              │                              │ IdP AS               │
└──────┬───────┘                              └──────────┬───────────┘
       │                                                 │
       │ Device Key lokal erzeugen                       │
       │ PKCE verifier + challenge erzeugen              │
       │ state + nonce erzeugen                           │
       │                                                 │
       │ Browser öffnen                                  │
       │ GET /oauth/authorize                            │
       │ client_id=weldall-cli                            │
       │ code_challenge=...                              │
       ├────────────────────────────────────────────────►│
       │                                                 │
       │                              Redirect zu CSG     │
       │                              Login / MFA         │
       │                                                 │
       │ Authorization Code über                         │
       │ 127.0.0.1:<random-port>/callback                │
       │◄────────────────────────────────────────────────┤
       │                                                 │
       │ POST /oauth/token                               │
       │ code + PKCE verifier                            │
       │ DPoP-Proof für Weldall Token Endpoint            │
       ├────────────────────────────────────────────────►│
       │                                                 │
       │ Weldall Access Token                             │
       │ ID Token                                        │
       │ rotierender Refresh Token                       │
       │◄────────────────────────────────────────────────┤
```

Der DPoP-Proof für den Code Exchange ist an diesen Request gebunden:

```json
{
  "htm": "POST",
  "htu": "https://weldall.example/oauth/token",
  "iat": 1770000000,
  "jti": "login-proof-id"
}
```

Weldall bindet die ausgestellten Credentials an den Device Key:

```text
Weldall Access Token
└── cnf.jkt = Device-Key-Thumbprint

Refresh-Token-Datensatz bei Weldall
└── erwarteter Device-Key-Thumbprint
```

Ein Refresh Token kann opaque sein. Dann steht `cnf.jkt` nicht sichtbar im Token,
sondern wird serverseitig mit dem Refresh-Token-Datensatz gespeichert.

### 6.3 Lokale Speicherung

Nach erfolgreichem Login speichert die CLI:

```text
Betriebssystem-Keychain
├── Device Private Key
└── rotierender Weldall Refresh Token

Arbeitsspeicher direkt nach `weldall login`
├── kurzlebiger Weldall Access Token
└── kurzlebiger ID Token

Zusätzlich und nur temporär während `weldall request`
├── zielgebundener ID-JAG
└── Downstream Access Token
```

`weldall login` stellt die Weldall Session mit Weldall Access Token, ID Token und
Refresh Token her. `weldall request` erzeugt just-in-time den zielgebundenen ID-JAG
und den Downstream Access Token für die angeforderte Resource und ihre Scopes.

Die CLI schreibt Access Tokens und ID-JAGs weder in Projektdateien noch in die
Shell-History oder Logs.

### 6.4 Erneuerung

Wenn ein Weldall Access Token oder ID Token abläuft:

```text
CLI
├── sendet Refresh Token
├── sendet neuen DPoP-Proof mit demselben Device Key
└── erhält rotierenden Refresh Token und neue kurzlebige Tokens
```

Ein gestohlener Refresh Token ist ohne den gebundenen Device Private Key nicht
nutzbar. Bei erfolgreicher Erneuerung wird der alte Refresh Token ungültig.

---

## 7. `weldall scopes`

### 7.1 Ziel

`weldall scopes` zeigt die aktuell effektiven, von Weldall berechneten
Berechtigungen des angemeldeten Mitarbeiters an.

Beispiel:

```text
$ weldall scopes

RESOURCE   AUTHORIZATION SERVER              GRANTED SCOPES
expenses   https://expenses.example/oauth    expenses:read
calendar   https://calendar.example/oauth    calendar:read
```

Mit `--resource` filtert die CLI die Ausgabe nach einer Resource:

```text
$ weldall scopes --json

expenses:read
```

### 7.2 Berechnung

Angezeigt werden nicht einfach alle existierenden Scopes, sondern die effektive
Schnittmenge:

```text
von der Resource unterstützte Scopes
∩ dem Mitarbeiter zugewiesene Scopes
∩ für weldall-cli erlaubte Scopes
∩ Client-Mapping zur Ziel-AS
∩ aktuelle Weldall Policy
```

### 7.3 Request

```text
CLI                                         Weldall
 │                                             │
 │ GET /api/me/scopes                          │
 │ Authorization: DPoP <weldall-access-token>   │
 │ DPoP: <proof>                               │
 ├────────────────────────────────────────────►│
 │                                             │
 │ effektive Resources und Scopes              │
 │◄────────────────────────────────────────────┤
```

Der Proof enthält beispielsweise:

```json
{
  "htm": "GET",
  "htu": "https://weldall.example/api/me/scopes",
  "ath": "hash-des-weldall-access-tokens",
  "iat": 1770000000,
  "jti": "scope-proof-id"
}
```

Weldall stellt dafür `GET /api/me/scopes` bereit. Die CLI-Ausgabe enthält keine
Credentials.

---

## 8. `weldall request`

### 8.1 Ziel

`weldall request` führt eine direkte Anfrage an eine registrierte API wie die
Expenses API aus.

Die Syntax für Request Body, Parameter und Response-Rendering ist ein separater
CLI-Designbereich. Der folgende Autorisierungsablauf gilt unabhängig von dieser
Syntax.

### 8.2 Vollständiger Ablauf

```text
┌──────────────┐       ┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│ Weldall CLI   │       │ Weldall       │       │ Expenses AS  │       │ Expenses API │
└──────┬───────┘       └──────┬───────┘       └──────┬───────┘       └──────┬───────┘
       │                      │                      │                      │
       │ 1. ID-JAG anfordern │                      │                      │
       │ POST /oauth/token   │                      │                      │
       │ DPoP-Proof          │                      │                      │
       ├────────────────────►│                      │                      │
       │                      │                      │                      │
       │     ID-JAG          │                      │                      │
       │◄────────────────────┤                      │                      │
       │                      │                      │                      │
       │ 2. ID-JAG einlösen                         │                      │
       │ POST /oauth/token                          │                      │
       │ ID-JAG + DPoP-Proof                        │                      │
       ├───────────────────────────────────────────►│                      │
       │                                             │                      │
       │             Expenses Access Token           │                      │
       │◄────────────────────────────────────────────┤                      │
       │                                                                    │
       │ 3. Expenses API Request                                           │
       │ Access Token + neuer DPoP-Proof                                   │
       ├───────────────────────────────────────────────────────────────────►│
       │                                                                    │
       │ Response                                                           │
       │◄───────────────────────────────────────────────────────────────────┤
```

### 8.3 Schritt 1: ID-JAG bei Weldall anfordern

```http
POST https://weldall.example/oauth/token
DPoP: <proof-für-weldall-token-endpoint>
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&requested_token_type=urn:ietf:params:oauth:token-type:id-jag
&audience=https://expenses.example/oauth
&resource=https://expenses.example/api
&scope=expenses:read
&subject_token=<weldall-refresh-token>
&subject_token_type=urn:ietf:params:oauth:token-type:refresh_token
```

Der DPoP-Proof ist nur an den Request zum Weldall Token Endpoint gebunden:

```json
{
  "htm": "POST",
  "htu": "https://weldall.example/oauth/token",
  "iat": 1770000000,
  "jti": "weldall-token-exchange-proof"
}
```

Für die CLI ist der rotierende Refresh Token der bevorzugte `subject_token`, weil
Weldall dessen Device-Key-Bindung serverseitig eindeutig prüfen und dabei aktuelle
Benutzer- und Policy-Daten laden kann. Alternativ kann ein frisch ausgestellter ID
Token verwendet werden, wenn Weldall dessen Bindung an dieselbe Login-Session und
denselben Device Key sicher validiert.

Weldall authentifiziert den Mitarbeiter, prüft den Device-Key-Besitz und wertet
die zentrale Policy aus. Anschließend signiert Weldall einen ID-JAG:

```json
{
  "iss": "https://weldall.example",
  "sub": "weldall-user-123",
  "aud": "https://expenses.example/oauth",
  "client_id": "weldall-cli-at-expenses",
  "resource": "https://expenses.example/api",
  "scope": "expenses:read",
  "cnf": {
    "jkt": "device-key-thumbprint"
  },
  "jti": "one-time-grant-id",
  "exp": 1770000300
}
```

Der ID-JAG ist:

- kein API Access Token,
- nicht für die Expenses API bestimmt,
- nicht an `GET /expenses` gebunden,
- für den Expenses Authorization Server bestimmt,
- kurzlebig und gegen Replay geschützt,
- im Weldall-CLI-Zielbild an den Device Key gebunden.

### 8.4 Schritt 2: ID-JAG beim Expenses AS einlösen

```http
POST https://expenses.example/oauth/token
DPoP: <proof-für-expenses-token-endpoint>
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-dpop
&assertion=<id-jag>
```

Der neue Proof enthält:

```json
{
  "htm": "POST",
  "htu": "https://expenses.example/oauth/token",
  "iat": 1770000010,
  "jti": "expenses-exchange-proof"
}
```

Der Expenses Authorization Server prüft:

```text
Weldall-Signatur des ID-JAG                       ✓
aud = Expenses Authorization Server              ✓
resource = Expenses API                           ✓
client_id = erlaubter Public Client               ✓
Scope lokal unterstützt                           ✓
Benutzer lokal auflösbar                          ✓
ID-JAG jti noch nicht verbraucht                  ✓
DPoP-Key passt zu cnf.jkt                         ✓
lokale Expenses Policy erlaubt den Zugriff        ✓
```

Danach signiert er einen Expenses Access Token:

```json
{
  "iss": "https://expenses.example/oauth",
  "sub": "local-expenses-user-789",
  "aud": "https://expenses.example/api",
  "client_id": "weldall-cli-at-expenses",
  "scope": "expenses:read",
  "cnf": {
    "jkt": "device-key-thumbprint"
  },
  "exp": 1770000610
}
```

### 8.5 Schritt 3: API Request ausführen

```http
GET https://expenses.example/api/expenses
Authorization: DPoP <expenses-access-token>
DPoP: <proof-für-diesen-api-request>
```

Der Proof enthält jetzt auch `ath`:

```json
{
  "htm": "GET",
  "htu": "https://expenses.example/api/expenses",
  "ath": "hash-des-expenses-access-tokens",
  "iat": 1770000020,
  "jti": "expenses-api-proof"
}
```

Die Expenses API prüft zwei Signaturen und ihre Bindung:

```text
Expenses Access Token
└── Signatur mit Expenses-AS-Public-Key prüfen

DPoP-Proof
└── Signatur mit Public Key aus dem Proof prüfen

Bindung
├── Thumbprint(Public Key aus Proof) == Access Token cnf.jkt
└── SHA-256(Access Token) == Proof ath
```

Zusätzlich prüft sie `aud`, `scope`, `exp`, `htm`, `htu`, `iat` und die
Replay-ID `jti`.

### 8.6 Weldall bleibt außerhalb des API-Datenpfads

```text
Weldall sieht:
├── Login
├── Scope-Abfrage
└── ID-JAG-Anforderung

Weldall sieht nicht:
├── Expenses Access Token
├── GET /api/expenses
└── Expenses Response
```

Die CLI ruft die Expenses API direkt auf. Weldall ist Policy Authority und
ID-JAG-Issuer, aber kein API-Proxy.

---

## 9. Token- und Proof-Übersicht

| Objekt                | Signiert von        | Verwendet bei            | Hauptzweck                                 |
| --------------------- | ------------------- | ------------------------ | ------------------------------------------ |
| Weldall Access Token  | Weldall             | Weldall APIs             | CLI gegenüber Weldall autorisieren         |
| Weldall ID Token      | Weldall             | CLI / ID-JAG Flow        | Identität des Mitarbeiters bestätigen      |
| Weldall Refresh Token | opaque oder Weldall | Weldall Token Endpoint   | kurzlebige Weldall Tokens erneuern         |
| ID-JAG                | Weldall             | Expenses Token Endpoint  | Downstream Access Token beantragen         |
| Expenses Access Token | Expenses AS         | Expenses API             | API-Zugriff autorisieren                   |
| DPoP-Proof            | Device Private Key  | jeder geschützte Request | Besitz des gebundenen Device Keys beweisen |

```text
Weldall Access Token  + DPoP-Proof → Weldall API
ID-JAG              + DPoP-Proof → Expenses AS
Expenses Access Token + DPoP-Proof → Expenses API
```

---

## 10. Replay-Schutz

DPoP-Proofs sind kurzlebig und besitzen eine eindeutige `jti`.

Jeder empfangende Server benötigt einen Replay Store für:

```text
Proof jti + erwartete Lebensdauer
```

Zusätzlich benötigt der Expenses Authorization Server einen Replay Store für die
`jti` des ID-JAG, wenn ein ID-JAG nur einmal eingelöst werden darf.

```text
DPoP-Proof erneut verwendet → ablehnen
ID-JAG erneut eingelöst     → ablehnen
Refresh Token Rotation verletzt → komplette Token-Familie widerrufen
```

Ein Server kann zusätzlich eine DPoP-Nonce verlangen. Diese wird vom Server
vorgegeben und muss im nächsten Proof enthalten sein.

---

## 11. Logout und Geräteverlust

Die CLI stellt einen Logout- und Revocation-Ablauf bereit:

```text
weldall logout
├── Refresh Token bei Weldall widerrufen
├── lokale Access Tokens löschen
├── lokale ID-JAGs löschen
└── Device Key aus dem Keychain löschen
```

Bei Verlust des Device Keys können gebundene Tokens nicht weiterverwendet werden.
Der Mitarbeiter muss sich erneut anmelden und erhält ein neues Device Keypair.

Mehrere Geräte desselben Mitarbeiters besitzen unabhängige Keys und
Refresh-Token-Familien, damit einzelne Geräte separat widerrufen werden können.

---

## 12. Sicherheitsgrenzen

DPoP bietet Schutz gegen die Wiederverwendung gestohlener Tokens, ersetzt aber
nicht:

- TLS,
- Benutzeranmeldung und MFA,
- Scope- und Fachautorisierung,
- sichere lokale Speicherung,
- Revocation,
- Schutz eines vollständig kompromittierten Geräts.

Ein Angreifer, der nur einen Token stiehlt, kann ihn ohne Device Private Key nicht
verwenden. Ein Angreifer mit vollständiger Kontrolle über das Gerät kann dagegen
unter Umständen sowohl Token als auch Key verwenden.

---

## 13. Weldall Protokollprofil

Die Weldall CLI ist ein öffentlicher nativer Client und kann kein geteiltes Secret
sicher halten. Das Weldall Protokollprofil legt deshalb fest:

1. Authorization Code + PKCE für den öffentlichen `weldall-cli` Client,
2. rotierende, an den Device Key gebundene Refresh Tokens,
3. ID-JAG-Ausstellung an den DPoP-key-gebundenen öffentlichen Client,
4. Unterstützung dieses Clients durch registrierte Resource Authorization Server,
5. ID-JAG- und Downstream-Access-Token-Bindung über `cnf.jkt`,
6. Verwendung des JWT-DPoP-Grant-Profils beim Downstream Exchange.

Der ID-JAG-Entwurf bevorzugt vertrauliche Clients. Das hier definierte Profil ist
eine kontrollierte Erweiterung für die interne Mitarbeiter-CLI. Conformance- und
Integrationstests müssen deshalb jede unterstützte Resource AS gegen dieses
Profil prüfen; allgemeine Interoperabilität darf nicht vorausgesetzt werden.

---

## 14. Standards und Entwürfe

Der Implementierungsplan basiert auf folgenden Dokumenten:

| Thema                                                       | Referenz                                                                                                    | Status                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------- |
| OAuth für native öffentliche Clients und Loopback Redirects | [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html)                                                     | Best Current Practice       |
| Authorization Code mit PKCE                                 | [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html)                                                     | Standards Track             |
| Aktuelle OAuth-Sicherheitsempfehlungen                      | [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)                                                     | Best Current Practice       |
| DPoP-Proofs und sendergebundene Tokens                      | [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html)                                                     | Standards Track             |
| JWK Thumbprints                                             | [RFC 7638](https://www.rfc-editor.org/rfc/rfc7638.html)                                                     | Standards Track             |
| `cnf` Confirmation Claim                                    | [RFC 7800](https://www.rfc-editor.org/rfc/rfc7800.html)                                                     | Standards Track             |
| JSON Web Signature                                          | [RFC 7515](https://www.rfc-editor.org/rfc/rfc7515.html)                                                     | Standards Track             |
| OAuth Token Exchange                                        | [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html)                                                     | Standards Track             |
| OAuth Authorization Server Metadata                         | [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html)                                                     | Standards Track             |
| OAuth Protected Resource Metadata                           | [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html)                                                     | Standards Track             |
| Identity Assertion JWT Authorization Grant                  | [ID-JAG Draft-04](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-identity-assertion-authz-grant-04) | IETF Work in Progress       |
| DPoP-gebundener JWT Authorization Grant                     | [JWT-DPoP Grant Draft-01](https://datatracker.ietf.org/doc/html/draft-parecki-oauth-jwt-dpop-grant-01)      | Individual Work in Progress |

Die RFCs sind stabile normative Grundlagen. ID-JAG und JWT-DPoP sind
Internet-Drafts und müssen für die Implementierung auf konkrete Versionen
gepinnt werden. Änderungen neuer Draft-Versionen werden vor einem Upgrade gegen
Conformance-, Security- und Integrationstests geprüft.

---

## 15. Zusammenfassung

```text
weldall login
└── Browser + CSG + PKCE
    └── Device-Key-gebundene Weldall Session

weldall scopes
└── Weldall Access Token + DPoP
    └── effektive Scopes des aktuellen Mitarbeiters

weldall request
├── ID-JAG bei Weldall anfordern
├── ID-JAG beim Resource AS einlösen
└── Ziel-API direkt mit Downstream Access Token + DPoP aufrufen
```

Die zentrale Trennung lautet:

```text
Token Claims bestimmen:       Was ist erlaubt?
DPoP-Proof bestimmt:           Wer besitzt den gebundenen Key?
htm / htu / ath bestimmen:     Für welchen aktuellen Request und Token gilt der Proof?
Weldall bestimmt:               Zentrale Policy und ID-JAG
Resource AS bestimmt:          Downstream Access Token
Resource Server bestimmt:      Fachliche Autorisierung und API Response
```
