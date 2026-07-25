# Weldall OAuth-, DPoP- und ID-JAG-Flow

Dieses Dokument beschreibt den aktuell implementierten Prototyp. Tokens und Codes sind in den HTTP-Beispielen gekürzt.

## 1. Beteiligte Systeme und URLs

```text
┌──────────────────────────┐
│ Weldall CLI               │
│ Public Native Client     │
│ client_id = weldall-cli   │
└────────────┬─────────────┘
             │ Browser + HTTP Requests
             ▼
┌──────────────────────────┐          ┌──────────────────────────┐
│ Weldall                   │─────────►│ Google                   │
│ OAuth/OIDC IdP-AS        │  Login   │ Upstream Identity        │
│ Next.js + Better Auth    │◄─────────│ Provider                 │
└────────────┬─────────────┘          └──────────────────────────┘
             │ ID-JAG
             ▼
┌──────────────────────────┐
│ Expenses Authorization   │
│ Server                   │
│ Hono, ohne Datenbank     │
└────────────┬─────────────┘
             │ Expenses Access Token
             ▼
┌──────────────────────────┐
│ Expenses Resource Server │
│ GET/POST/DELETE API      │
└──────────────────────────┘
```

| System                         | Öffentliche URL                                              |
| ------------------------------ | ------------------------------------------------------------ |
| Weldall                        | `https://weldall.seibert.localdev`                           |
| Weldall Authorization Endpoint | `https://weldall.seibert.localdev/api/auth/oauth2/authorize` |
| Weldall Token Endpoint         | `https://weldall.seibert.localdev/api/auth/oauth2/token`     |
| Weldall Revocation Endpoint    | `https://weldall.seibert.localdev/api/auth/oauth2/revoke`    |
| Weldall API                    | `https://weldall.seibert.localdev/api`                       |
| Expenses Authorization Server  | `https://expenses.seibert.localdev`                          |
| Expenses Token Endpoint        | `https://expenses.seibert.localdev/oauth/token`              |
| Expenses API                   | `https://expenses.seibert.localdev/api`                      |

Caddy terminiert lokal TLS und leitet Weldall intern an Port `3000` sowie Expenses an Port `3001` weiter. Protokollvergleiche verwenden immer die öffentlichen HTTPS-URLs.

Die einzigen HTTP-Ausnahmen sind:

- Googles lokaler Callback `http://localhost:3000/api/auth/callback/google`
- der zufällige native CLI-Callback `http://127.0.0.1:<port>/callback`

## 2. Gesamtablauf

```text
CLI                  Browser          Weldall          Google       Expenses AS      Expenses API
 │                      │                 │                │              │                │
 │ weldall login         │                 │                │              │                │
 │─ Authorization URL ─►│                 │                │              │                │
 │                      │─ authorize ────►│                │              │                │
 │                      │                 │─ Google Login ─►│              │                │
 │                      │                 │◄─ Identity ─────│              │                │
 │                      │◄─ CLI code ─────│                │              │                │
 │◄─ loopback callback ─│                 │                │              │                │
 │                                        │                │              │                │
 │─ code + PKCE + DPoP ──────────────────►│                │              │                │
 │◄─ Access + ID + Refresh Token ─────────│                │              │                │
 │                                        │                │              │                │
 │ weldall request                        │                │              │                │
 │─ Refresh Token + DPoP ────────────────►│                │              │                │
 │◄─ Weldall Access + neuer Refresh ───────│                │              │                │
 │─ GET /api/me/scopes + DPoP ──────────►│                │              │                │
 │◄─ Resource Registry + Scopes ──────────│                │              │                │
 │                                        │                │              │                │
 │─ Refresh Token als subject_token ─────►│                │              │                │
 │◄─ ID-JAG ──────────────────────────────│                │              │                │
 │                                                                         │                │
 │─ ID-JAG + DPoP ────────────────────────────────────────────────────────►│                │
 │◄─ Expenses Access Token ────────────────────────────────────────────────│                │
 │                                                                                          │
 │─ Access Token + DPoP ──────────────────────────────────────────────────────────────────►│
 │◄─ API Response ─────────────────────────────────────────────────────────────────────────│
```

## 3. DPoP-Grundlagen

Jede CLI-Installation erzeugt beim Login ein eigenes ES256-P-256-Keypair.

```text
macOS Keychain
├── Device Private JWK
├── Device Public JWK
└── aktueller Weldall Refresh Token
```

Der Private Key verlässt das Gerät nicht. Weldall und Expenses speichern beziehungsweise übernehmen nur den RFC-7638-Thumbprint des Public Keys:

```json
{
  "cnf": {
    "jkt": "base64url-sha256-jwk-thumbprint"
  }
}
```

Jeder geschützte Request enthält einen neuen `DPoP`-Header:

```http
DPoP: <proof-jwt>
```

Header des Proof-JWT:

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

Payload eines Token-Endpoint-Proofs:

```json
{
  "htm": "POST",
  "htu": "https://weldall.seibert.localdev/api/auth/oauth2/token",
  "iat": 1780000000,
  "jti": "einmalige-proof-id"
}
```

Bei einem API-Request kommt `ath` hinzu:

```json
{
  "htm": "GET",
  "htu": "https://expenses.seibert.localdev/api/expenses",
  "ath": "base64url-sha256-des-access-tokens",
  "iat": 1780000010,
  "jti": "weitere-einmalige-proof-id"
}
```

| Claim | Zweck                                                   |
| ----- | ------------------------------------------------------- |
| `htm` | Bindung an die HTTP-Methode                             |
| `htu` | Bindung an die öffentliche Ziel-URL ohne Query/Fragment |
| `iat` | enges Gültigkeitsfenster                                |
| `jti` | Replay-Erkennung                                        |
| `ath` | Bindung an einen konkreten Access Token                 |

Token Endpoints verlangen kein `ath`, weil dort kein Access Token als API-Credential präsentiert wird. Geschützte Resource Requests verlangen dagegen immer `ath`.

## 4. `weldall login`

### 4.1 Lokale Vorbereitung

Die CLI:

1. erzeugt ein ES256-Device-Keypair,
2. erzeugt `state`, OIDC-`nonce` und einen PKCE-Verifier,
3. berechnet `code_challenge = BASE64URL(SHA-256(code_verifier))`,
4. startet einen HTTP-Server auf `127.0.0.1` mit zufälligem Port,
5. öffnet den Browser.

### 4.2 Authorization Request der CLI

```http
GET /api/auth/oauth2/authorize?
  response_type=code&
  client_id=weldall-cli&
  redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2Fcallback&
  scope=openid%20offline_access%20weldall%3Ascopes&
  state=<random-state>&
  nonce=<random-nonce>&
  code_challenge=<pkce-challenge>&
  code_challenge_method=S256&
  resource=https%3A%2F%2Fweldall.seibert.localdev%2Fapi&
  dpop_jkt=<device-key-thumbprint>
Host: weldall.seibert.localdev
```

Bedeutung der wichtigsten Parameter:

| Parameter        | Bedeutung                                            |
| ---------------- | ---------------------------------------------------- |
| `client_id`      | fest registrierter öffentlicher Client `weldall-cli` |
| `redirect_uri`   | dynamischer nativer Loopback-Callback                |
| `state`          | CSRF- und Request/Response-Bindung                   |
| `nonce`          | Bindung des ID Tokens an diesen Login                |
| `code_challenge` | PKCE-Schutz des Authorization Codes                  |
| `resource`       | gewünschte Audience des Weldall Access Tokens        |
| `dpop_jkt`       | Device-Key-Bindung des Codes und der Tokens          |

Der Client ist durch Prisma-Migrationen ohne Secret registriert. PKCE und DPoP sind für ihn verpflichtend.

### 4.3 Google-Login innerhalb Weldalls

Wenn noch keine Weldall-Browser-Session existiert, leitet Better Auth auf `/login` um. Der Login-Button startet den Google Social Login.

Vereinfacht erzeugt Better Auth folgenden Google-Request:

```http
GET https://accounts.google.com/o/oauth2/v2/auth?
  client_id=<GOOGLE_CLIENT_ID>&
  redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fauth%2Fcallback%2Fgoogle&
  response_type=code&
  scope=openid%20email%20profile&
  state=<better-auth-state>
```

Google ruft nach erfolgreichem Login zurück:

```http
GET http://localhost:3000/api/auth/callback/google?
  code=<google-authorization-code>&
  state=<better-auth-state>
```

Der Google Authorization Code ist nicht der spätere Weldall Authorization Code. Better Auth tauscht den Google Code serverseitig mit `GOOGLE_CLIENT_ID` und `GOOGLE_CLIENT_SECRET` aus, erstellt beziehungsweise lädt User, Google Account und Browser-Session und setzt den ursprünglichen Weldall-Authorize-Flow fort.

Da Google `.localdev` nicht als Callback akzeptiert, transportiert Better Auths OAuth-Proxy-Plugin das Ergebnis kurzlebig verschlüsselt von `localhost:3000` zurück zu `https://weldall.seibert.localdev`.

### 4.4 Authorization Response an die CLI

Weldall schickt einen eigenen, einmalig verwendbaren Authorization Code an den Loopback-Callback:

```http
GET http://127.0.0.1:43123/callback?
  code=<weldall-authorization-code>&
  state=<random-state>&
  iss=https%3A%2F%2Fweldall.seibert.localdev
```

Die CLI prüft:

- Callback-Pfad `/callback`,
- exakt passendes `state`,
- exakt passenden Issuer `iss`,
- einmalige Verwendung und Timeout.

### 4.5 Code Exchange mit PKCE und DPoP

```http
POST /api/auth/oauth2/token HTTP/1.1
Host: weldall.seibert.localdev
Content-Type: application/x-www-form-urlencoded
DPoP: <proof-fuer-weldall-token-endpoint>

grant_type=authorization_code
&client_id=weldall-cli
&code=<weldall-authorization-code>
&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2Fcallback
&code_verifier=<pkce-verifier>
```

Weldall/Better Auth prüft:

- Client und Redirect URI,
- Authorization Code aktiv und noch nicht verwendet,
- PKCE-S256-Verifier,
- DPoP-Signatur, `htm`, `htu`, `iat` und `jti`,
- DPoP-Key gegen `dpop_jkt` des Authorization Requests.

Antwort:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{
  "token_type": "DPoP",
  "access_token": "<weldall-access-token>",
  "id_token": "<weldall-id-token>",
  "refresh_token": "<opaque-refresh-token>",
  "expires_in": 3600,
  "scope": "openid offline_access weldall:scopes"
}
```

Der Weldall Access Token enthält unter anderem:

```json
{
  "iss": "https://weldall.seibert.localdev",
  "sub": "<weldall-user-id>",
  "aud": [
    "https://weldall.seibert.localdev/api",
    "https://weldall.seibert.localdev/api/auth/oauth2/userinfo"
  ],
  "scope": "openid offline_access weldall:scopes",
  "cnf": { "jkt": "<device-key-thumbprint>" }
}
```

Die CLI validiert Access Token, ID Token, Signatur, Issuer, Audience, Zeitclaims, ID-Token-`nonce` und `cnf.jkt`.

Danach speichert sie nur Device Key und Refresh Token im Keychain. Access Token und ID Token werden nicht dauerhaft gespeichert.

### 4.6 Weldall-Persistenz beim Login

Better Auth speichert unter anderem:

```text
User
Account (Google)
Session (Browser)
OauthRefreshToken
```

Die Token-Facade ergänzt:

```text
OAuthDeviceRefreshBinding
├── Hash des Refresh Tokens
├── User-ID
├── client_id = weldall-cli
├── familyId
├── dpopJkt
├── expiresAt
├── rotatedAt / revokedAt
└── replacementHash
```

Der rohe Refresh Token steht nicht in dieser Sidecar-Tabelle.

## 5. Refresh und `weldall scopes`

Da jeder CLI-Aufruf ein neuer Prozess ist, liest die CLI den aktuellen Refresh Token und Device Key aus dem Keychain.

### 5.1 Refresh Request

```http
POST /api/auth/oauth2/token HTTP/1.1
Host: weldall.seibert.localdev
Content-Type: application/x-www-form-urlencoded
DPoP: <neuer-proof>

grant_type=refresh_token
&refresh_token=<aktueller-refresh-token>
&client_id=weldall-cli
```

Weldall prüft zusätzlich zur Better-Auth-Validierung:

- Sidecar-Binding aktiv,
- Refresh Token nicht bereits rotiert,
- DPoP-Thumbprint entspricht `dpopJkt`,
- Token-Familie nicht widerrufen.

Antwort:

```json
{
  "token_type": "DPoP",
  "access_token": "<neuer-weldall-access-token>",
  "refresh_token": "<rotierter-refresh-token>"
}
```

Die CLI ersetzt den bisherigen Refresh Token im Keychain atomar unter ihrem prozessübergreifenden CLI-Lock.

```text
Refresh Token A ──refresh──► Refresh Token B
      │                           │
      └─ rotatedAt gesetzt        └─ gleicher familyId
```

Wird Token A später erneut verwendet, wird die gesamte Familie widerrufen.

### 5.2 Scope Request

```http
GET /api/me/scopes HTTP/1.1
Host: weldall.seibert.localdev
Authorization: DPoP <weldall-access-token>
DPoP: <proof-mit-ath>
```

Weldall prüft:

- Signatur, Issuer und Audience des Access Tokens,
- Scope `weldall:scopes`,
- `cnf.jkt` gegen den Proof-Key,
- `ath` gegen den Access Token,
- `htm=GET`, kanonisches `htu`, `iat` und Replay-`jti`,
- User existiert und besitzt eine verifizierte E-Mail.

Die Antwort ist gleichzeitig die Resource Registry der CLI:

```json
[
  {
    "key": "expenses",
    "name": "Expenses",
    "resourceIdentifier": "https://expenses.seibert.localdev/api",
    "authorizationServer": "https://expenses.seibert.localdev",
    "downstreamClientId": "weldall-cli-at-expenses",
    "requestPrefixes": ["https://expenses.seibert.localdev/api"],
    "supportedScopes": ["expenses:create", "expenses:delete", "expenses:read", "expenses:write"],
    "grantedScopes": ["expenses:create", "expenses:delete", "expenses:read", "expenses:write"]
  }
]
```

Resource-Definitionen, Präfixe und unterstützte Scopes stammen aus der Downstream-Registry in PostgreSQL. `grantedScopes` wird unabhängig davon ausschließlich aus den versionierten Benutzer-Assignments abgeleitet. Jede aktive Resource wird ausgegeben; System-Scopes wie `weldall:administer` können keiner Downstream-Resource zugeordnet werden.

## 6. `weldall request`

Beispiel:

```bash
weldall request --scope expenses:read \
  https://expenses.seibert.localdev/api/expenses
```

Die CLI führt dabei vier Schritte aus:

```text
1. Weldall Access Token erneuern und Scope-/Resource-Registry laden
2. Ziel-URL anhand von Origin und Pfadsegmenten genau einer Resource zuordnen
3. Unterstützte und gewährte Scopes prüfen und bei Weldall einen ID-JAG anfordern
4. ID-JAG beim registrierten AS gegen einen Access Token tauschen
5. Die vollständige HTTPS-URL direkt mit einem dafür gebundenen DPoP-Proof aufrufen
```

### 6.1 Schritt 1: Refresh und Registry

`weldall request` verwendet denselben Refresh- und `GET /api/me/scopes`-Ablauf wie `weldall scopes`. Die Ziel-URL stammt direkt aus dem CLI-Aufruf und wird nicht aus einem Endpunktkatalog zusammengesetzt. Vor jedem Token Exchange muss sie aber anhand des exakten Origins und einer Pfadsegment-Grenze genau einem registrierten Präfix entsprechen. Erst danach prüft die CLI unterstützte und gewährte Scopes. Redirects werden nicht verfolgt.

### 6.2 Schritt 2: ID-JAG bei Weldall anfordern

```http
POST /api/auth/oauth2/token HTTP/1.1
Host: weldall.seibert.localdev
Content-Type: application/x-www-form-urlencoded
DPoP: <proof-fuer-weldall-token-endpoint>

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&requested_token_type=urn:ietf:params:oauth:token-type:id-jag
&audience=https%3A%2F%2Fexpenses.seibert.localdev
&resource=https%3A%2F%2Fexpenses.seibert.localdev%2Fapi
&scope=expenses%3Aread
&subject_token=<aktueller-weldall-refresh-token>
&subject_token_type=urn:ietf:params:oauth:token-type:refresh_token
&client_id=weldall-cli
```

`subject_token` ist in diesem Profil der aktuelle Weldall Refresh Token. Er weist die bestehende Weldall-Anmeldung nach. Weldall prüft dazu sowohl Better Auths `OauthRefreshToken` als auch `OAuthDeviceRefreshBinding`.

Der ID-JAG Draft-04 zeigt primär einen ID Token als `subject_token`, erlaubt aber in §4.3.2 auch die hier implementierte Refresh-Token-Variante, wenn der IdP sie unterstützt.

Weldall prüft:

- Refresh Token aktiv, unrotiert und nicht widerrufen,
- Better-Auth- und Sidecar-Datensatz stimmen überein,
- User, Public Client und Device-Key-Bindung,
- Ziel-Audience und Resource wählen exakt dieselbe aktive DB-Resource,
- angeforderte Scopes werden von dieser Resource unterstützt und sind dem User gewährt,
- DPoP-Proof ist gültig und noch nicht verwendet.

Antwort gemäß Token Exchange:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{
  "issued_token_type": "urn:ietf:params:oauth:token-type:id-jag",
  "access_token": "<signed-id-jag>",
  "token_type": "N_A",
  "expires_in": 300,
  "scope": "expenses:read"
}
```

Das Feld heißt aus historischen Gründen `access_token`, obwohl der ID-JAG kein API Access Token ist.

Der ID-JAG enthält:

```json
{
  "iss": "https://weldall.seibert.localdev",
  "sub": "<weldall-user-id>",
  "aud": "https://expenses.seibert.localdev",
  "client_id": "weldall-cli-at-expenses",
  "resource": "https://expenses.seibert.localdev/api",
  "scope": "expenses:read",
  "cnf": { "jkt": "<device-key-thumbprint>" },
  "jti": "<one-time-grant-id>",
  "iat": 1780000020,
  "exp": 1780000320,
  "urn:weldall:id-jag-draft": "draft-ietf-oauth-identity-assertion-authz-grant-04"
}
```

JWT-Header:

```json
{
  "alg": "ES256",
  "kid": "<weldall-signing-kid>",
  "typ": "oauth-id-jag+jwt"
}
```

### 6.3 Schritt 3: ID-JAG beim Expenses AS einlösen

```http
POST /oauth/token HTTP/1.1
Host: expenses.seibert.localdev
Content-Type: application/x-www-form-urlencoded
DPoP: <neuer-proof-fuer-expenses-token-endpoint>

grant_type=urn:ietf:params:oauth:grant-type:jwt-dpop
&assertion=<signed-id-jag>
```

Expenses prüft:

- ID-JAG-Signatur mit Weldalls Public Key,
- `typ=oauth-id-jag+jwt` und `alg=ES256`,
- exakten Weldall-Issuer,
- `aud=https://expenses.seibert.localdev`,
- `resource=https://expenses.seibert.localdev/api`,
- `client_id=weldall-cli-at-expenses`,
- `iat`, `exp`, maximale Laufzeit und `jti`,
- alle Scopes werden lokal unterstützt,
- DPoP-Signatur und Request-Bindung,
- Proof-Key-Thumbprint entspricht `ID-JAG.cnf.jkt`,
- Proof-`jti` und ID-JAG-`jti` wurden noch nicht verwendet.

Antwort:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{
  "token_type": "DPoP",
  "access_token": "<expenses-access-token>",
  "expires_in": 600,
  "scope": "expenses:read"
}
```

Der Expenses Access Token enthält:

```json
{
  "iss": "https://expenses.seibert.localdev",
  "sub": "<weldall-user-id>",
  "aud": "https://expenses.seibert.localdev/api",
  "client_id": "weldall-cli-at-expenses",
  "scope": "expenses:read",
  "cnf": { "jkt": "<device-key-thumbprint>" },
  "jti": "<access-token-id>",
  "iat": 1780000030,
  "exp": 1780000630
}
```

Der Token ist mit dem Expenses Signing Key signiert und hat `typ=at+jwt`.

### 6.4 Schritt 4: Expenses API direkt aufrufen

#### GET

CLI-Aufruf:

```bash
weldall request --scope expenses:read \
  https://expenses.seibert.localdev/api/expenses
```

HTTP-Request:

```http
GET /api/expenses HTTP/1.1
Host: expenses.seibert.localdev
Authorization: DPoP <expenses-access-token>
DPoP: <proof-mit-ath>
```

Benötigte Scopes:

```text
expenses:read
```

#### POST

CLI-Aufruf:

```bash
weldall request --method POST \
  --scope expenses:create \
  --json '{"description":"Train","amount":24}' \
  https://expenses.seibert.localdev/api/expenses
```

HTTP-Request:

```http
POST /api/expenses HTTP/1.1
Host: expenses.seibert.localdev
Content-Type: application/json
Authorization: DPoP <expenses-access-token>
DPoP: <proof-mit-ath>

{
  "description": "Train",
  "amount": 24
}
```

Benötigte Scopes:

```text
expenses:create
```

#### DELETE mit All-of-Scopes

CLI-Aufruf:

```bash
weldall request --method DELETE \
  --scope expenses:delete \
  --scope expenses:write \
  https://expenses.seibert.localdev/api/expenses/expense-1
```

HTTP-Request:

```http
DELETE /api/expenses/expense-1 HTTP/1.1
Host: expenses.seibert.localdev
Authorization: DPoP <expenses-access-token>
DPoP: <proof-mit-ath>
```

Beide Scopes müssen im Token vorhanden sein:

```text
expenses:delete AND expenses:write
```

Für jeden API-Request prüft die gemeinsame Hono-Middleware:

```text
Expenses-Signatur des Access Tokens
+ exakter Issuer und Audience
+ client_id
+ Ablauf und erforderliche All-of-Scopes
+ Access Token cnf.jkt
+ DPoP-Proof-Signatur
+ htm / kanonisches öffentliches htu
+ ath
+ enges iat-Fenster
+ einmalige Proof-jti
```

Weldall ist an diesem API-Aufruf nicht beteiligt und sieht weder den Expenses Access Token noch Request oder Response.

## 7. `weldall logout`

```http
POST /api/auth/oauth2/revoke HTTP/1.1
Host: weldall.seibert.localdev
Content-Type: application/x-www-form-urlencoded
DPoP: <proof-fuer-revocation-endpoint>

token=<aktueller-refresh-token>
&token_type_hint=refresh_token
&client_id=weldall-cli
```

Die Revocation-Facade:

1. findet das Binding über den Refresh-Token-Hash,
2. prüft den DPoP-Key gegen `dpopJkt`,
3. delegiert die eigentliche Revocation an Better Auth,
4. markiert die gesamte Sidecar-Familie als widerrufen.

Die CLI entfernt anschließend den Keychain-Eintrag mit Device Key und Refresh Token. Das geschieht auch dann lokal, wenn der Remote-Revocation-Request fehlschlägt; der Fehler wird ausgegeben.

## 8. Facade-Aufteilung in Weldall

```text
POST /api/auth/oauth2/token
            │
            ▼
      tokenFacade
       ├── grant_type=authorization_code
       │     └── Better Auth
       │           └── Facade prüft Antwort und legt Device-Binding an
       │
       ├── grant_type=refresh_token
       │     ├── Sidecar-/DPoP-Vorprüfung
       │     ├── Better Auth Rotation
       │     └── Sidecar-Rotation / Family Revocation
       │
       └── grant_type=...:token-exchange
             └── eigene ID-JAG-Ausstellung

POST /api/auth/oauth2/revoke
            │
            ▼
    revocationFacade
       ├── Sidecar-/DPoP-Prüfung
       ├── Better Auth Revocation
       └── Sidecar-Familie widerrufen

alle anderen /api/auth/* Requests
            │
            ▼
      Better Auth Catch-all
```

Better Auth bleibt für Standard-OAuth-Grants, Sessions und Google zuständig. Die Facades ergänzen das Weldall-spezifische ID-JAG-/DPoP-Profil.

## 9. Discovery- und JWKS-Endpunkte

### Weldall

```http
GET /.well-known/oauth-authorization-server
GET /.well-known/openid-configuration
GET /.well-known/oauth-protected-resource/api
GET /api/oauth/jwks
```

### Expenses

```http
GET /.well-known/oauth-authorization-server
GET /.well-known/oauth-protected-resource
GET /.well-known/oauth-protected-resource/api
GET /.well-known/jwks.json
```

Die CLI verwendet die bei jedem Request aus PostgreSQL erzeugte Registry von `GET /api/me/scopes`. Für Downstream-Services findet keine Discovery statt; der Token Endpoint ist vertraglich `<authorizationServer>/oauth/token`. Die Well-Known-Endpunkte der Demo dokumentieren trotzdem Issuer, Resource und JWKS.

## 10. Persistenz und Lebensdauer

```text
macOS Keychain
├── Device Private/Public Key
└── aktueller Weldall Refresh Token

CLI-Arbeitsspeicher
├── Weldall Access Token
├── Weldall ID Token
├── ID-JAG
├── Expenses Access Token
└── DPoP-Proofs

Weldall PostgreSQL
├── Better Auth User / Account / Session
├── OAuth Client / Resource
├── OauthRefreshToken
└── OAuthDeviceRefreshBinding

Expenses-Prozessspeicher
├── DPoP-jti Replay Store
└── ID-JAG-jti Replay Store
```

| Objekt                | Persistiert?                                    |
| --------------------- | ----------------------------------------------- |
| Device Private Key    | macOS Keychain                                  |
| Weldall Refresh Token | macOS Keychain und gehasht bei Weldall          |
| Weldall Access Token  | nur CLI-Arbeitsspeicher                         |
| ID Token              | nur CLI-Arbeitsspeicher während Login           |
| ID-JAG                | nur CLI-Arbeitsspeicher                         |
| Expenses Access Token | nur CLI-Arbeitsspeicher                         |
| DPoP-Proof            | nicht persistiert; nur Replay-`jti` gespeichert |

Die In-Memory-Replay-Stores gelten nur pro Prozess und werden bei einem Neustart geleert. Der Prototyp muss daher mit genau einer Instanz je Server betrieben werden.
