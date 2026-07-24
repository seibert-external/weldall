# DPoP-Schlüssel über macOS Secure Enclave signieren

## Problem

Die CLI erzeugt beim Login aktuell ein exportierbares ES256-/P-256-Schlüsselpaar. Private JWK, Public JWK, JKT und rotierender Refresh Token werden gemeinsam als JSON in der macOS Keychain gespeichert.

Für jeden DPoP-Proof wird der private JWK aus der Keychain gelesen, mit `jose.importJWK()` in den Node.js-Prozess importiert und dort für die Signatur verwendet. Der private Schlüssel ist dadurch während des CLI-Befehls im Prozessspeicher vorhanden und kann prinzipiell exportiert werden.

macOS kann P-256-Schlüssel direkt in der Secure Enclave erzeugen und Signaturen über `Security.framework` ausführen. Der private Schlüssel verlässt dabei die Secure Enclave nicht.

## Ziel

Die Weldall-CLI soll auf unterstützten Macs einen nicht exportierbaren Secure-Enclave-Schlüssel für DPoP verwenden:

```text
weldall login
  ├─ P-256-Schlüssel in Secure Enclave erzeugen
  ├─ Public Key als JWK ableiten
  ├─ JKT berechnen
  └─ nur Key-Referenz + Public JWK + JKT + Refresh Token speichern

DPoP-Proof
  ├─ Header und Payload in Node.js erzeugen
  ├─ Signing Input an nativen Signer übergeben
  ├─ Secure Enclave signiert intern
  └─ nur Signatur wird an Node.js zurückgegeben
```

Der private Parameter `d` darf weder in der Keychain noch im Node.js-Speicher oder in Logs erscheinen.

## Abgrenzung

Diese Änderung schützt den lokalen privaten DPoP-Schlüssel. Sie löst nicht alle Credential-Risiken:

- Der rotierende Refresh Token wird weiterhin aus der Keychain in den Prozessspeicher geladen.
- Access Tokens und erzeugte DPoP-Proofs befinden sich während eines Requests kurz im Speicher.
- Ein kompromittierter Prozess, der im Namen der CLI signieren darf, könnte die Signierfunktion missbrauchen, auch wenn er den privaten Schlüssel nicht extrahieren kann.
- Secure Enclave liefert ohne zusätzliches Attestierungsverfahren keinen serverseitigen Beweis, dass ein JKT tatsächlich hardwaregebunden ist.

## Native macOS-Integration

Für die Implementierung sind die APIs aus `Security.framework` zu verwenden:

- `SecKeyCreateRandomKey` zur Schlüsselerzeugung,
- `kSecAttrKeyTypeECSECPrimeRandom` und 256 Bit,
- `kSecAttrTokenIDSecureEnclave` für Hardwarebindung,
- `kSecAttrIsPermanent` und ein eindeutiger Application Tag,
- `SecKeyCopyPublicKey` für den öffentlichen Schlüssel,
- `SecKeyCopyExternalRepresentation` nur auf dem öffentlichen Schlüssel,
- `SecKeyCreateSignature` für ECDSA/SHA-256,
- `SecItemCopyMatching` und `SecItemDelete` zum Finden bzw. Löschen des Schlüssels.

Der Secure-Enclave-Schlüssel muss auf dem Gerät erzeugt werden. Ein bestehender privater JWK kann nicht in die Secure Enclave importiert werden.

## Native Bridge für Node.js

`@napi-rs/keyring` verwaltet Generic-Password-Einträge, stellt aber keine `SecKey`-Signaturoperation bereit. Deshalb wird eine zusätzliche Bridge benötigt.

Folgende Ansätze vergleichen und als Architecture Decision dokumentieren:

1. **N-API-Addon:** Direkter Aufruf von `Security.framework` aus dem CLI-Prozess.
2. **Mitgelieferter Swift-Helper:** Kleines signiertes Executable mit streng definiertem stdin/stdout-Protokoll.
3. **Separater lokaler Signing Service:** Nur sinnvoll, falls später mehrere Prozesse denselben Schlüssel kontrolliert verwenden sollen.

Für das MVP sind N-API-Addon oder Swift-Helper zu bevorzugen. Der gewählte Ansatz muss mit dem geplanten ausführbaren CLI-Artefakt, Code Signing, Notarisierung und allen unterstützten macOS-Architekturen funktionieren.

### Minimale native API

Die Bridge soll eine kleine, klar begrenzte Schnittstelle anbieten:

```ts
interface NativeDpopKeyStore {
  create(label: string): Promise<{
    keyId: string;
    publicKey: Uint8Array;
  }>;

  sign(keyId: string, signingInput: Uint8Array): Promise<Uint8Array>;
  exists(keyId: string): Promise<boolean>;
  delete(keyId: string): Promise<void>;
}
```

Private Schlüsselbytes dürfen von keiner API zurückgegeben werden.

## DPoP-Signer-Abstraktion

Die Protokollimplementierung darf nicht länger voraussetzen, dass ein `privateJwk` vorhanden ist. Stattdessen wird eine Signer-Abstraktion eingeführt:

```ts
interface DpopSigner {
  publicJwk: JWK;
  jkt: string;
  sign(signingInput: Uint8Array): Promise<Uint8Array>;
}
```

`createDpopProof()` verwendet den Signer, um:

1. den geschützten JOSE-Header mit dem Public JWK zu erzeugen,
2. Payload mit `htm`, `htu`, `iat`, `jti` und optional `ath` zu erzeugen,
3. Base64url-Header und -Payload zum JWS Signing Input zu verbinden,
4. den Signing Input signieren zu lassen,
5. die Signatur als Base64url an das Compact JWS anzuhängen.

Für Tests und nicht-macOS-Plattformen kann ein separater JWK-basierter Signer bestehen bleiben. Framework- und Protokollcode erhält dadurch keine macOS-Abhängigkeit.

## Signaturformat

Apple liefert ECDSA-Signaturen über `SecKeyCreateSignature` typischerweise als ASN.1-DER-kodiertes X9.62-Paar `(r, s)`. JWS/DPoP mit ES256 erwartet dagegen eine 64 Byte lange JOSE-Signatur:

```text
r[32 Byte] || s[32 Byte]
```

Die native Bridge oder Core-Library muss daher sicher konvertieren:

- DER-Struktur strikt parsen,
- genau zwei positive Integer akzeptieren,
- unnötige führende Nullbytes korrekt behandeln,
- `r` und `s` jeweils auf genau 32 Byte auffüllen,
- überlange, negative, nicht-kanonische oder anderweitig ungültige Werte ablehnen,
- niemals stillschweigend abschneiden.

Die resultierenden Proofs müssen mit der bestehenden JOSE-/DPoP-Verifikation kompatibel sein. Testvektoren decken Randfälle der DER-zu-JOSE-Konvertierung ab.

## Public JWK und JKT

Der öffentliche P-256-Schlüssel wird aus der X9.63-Darstellung verarbeitet:

```text
0x04 || X[32 Byte] || Y[32 Byte]
```

Daraus entsteht:

```json
{
  "kty": "EC",
  "crv": "P-256",
  "x": "<base64url>",
  "y": "<base64url>"
}
```

Der JKT wird wie bisher gemäß RFC 7638 aus dem kanonischen Public JWK berechnet. Ein beim Laden neu berechneter JKT muss mit dem gespeicherten Wert übereinstimmen; Abweichungen führen zu einem Fehler und nicht zu einer stillen Reparatur.

## Speicherung in der Keychain

Nach der Umstellung enthält der Session-Eintrag keine private JWK mehr:

```ts
interface StoredCredentialsV2 {
  version: 2;
  keyProvider: "macos-secure-enclave";
  keyId: string;
  publicJwk: JWK;
  jkt: string;
  refreshToken: string;
}
```

Anforderungen:

- `keyId` ist eine opaque Referenz bzw. ein kontrollierter Application Tag, kein Schlüsselmaterial.
- Der Secure-Enclave-Schlüssel und der Generic-Password-Eintrag erhalten getrennte, kollisionsfreie Bezeichner.
- Geladene Daten werden strikt validiert und nicht nur per Type Cast akzeptiert.
- Es wird geprüft, dass der referenzierte Schlüssel existiert und zum gespeicherten Public JWK gehört.
- Keychain-Fehler dürfen nicht pauschal als „nicht eingeloggt“ verschluckt werden.
- Refresh Token und Schlüsselreferenz werden niemals in Debug Logs ausgegeben.

## Access Control und Benutzerinteraktion

Die Access-Control-Policy muss zur CLI-Nutzung passen:

- Der Schlüssel darf nur für Private-Key-Operationen verwendet werden.
- Der Schlüssel ist nur auf diesem Gerät verfügbar und nicht migrierbar.
- Eine Touch-ID-/Passwort-Abfrage bei jeder DPoP-Signatur ist für normale CLI-Befehle voraussichtlich ungeeignet, da ein Request mehrere Proofs erzeugt.
- Optional kann später ein interaktiver Hochsicherheitsmodus mit Benutzerbestätigung angeboten werden.
- Verhalten bei gesperrter Keychain, fehlender Benutzer-Session und SSH-/CI-Nutzung wird dokumentiert.
- Zugriffsregeln müssen mit einem signierten und aktualisierbaren CLI-Executable funktionieren, ohne nach jedem Release unnötige Berechtigungsdialoge zu erzeugen.

## Login, Refresh und Logout

### Login

- Vor dem Login wird ein neuer Secure-Enclave-Schlüssel erzeugt.
- Sein JKT wird als `dpop_jkt` im Authorization Request verwendet.
- Token Request und Antwortvalidierung verwenden den nativen Signer.
- Credentials werden erst nach vollständig erfolgreichem Login persistiert.
- Bei abgebrochenem oder fehlgeschlagenem Login wird der neu erzeugte, noch ungenutzte Schlüssel gelöscht.

### Refresh und Requests

- Derselbe Secure-Enclave-Schlüssel wird während der gesamten Login-Session verwendet.
- Nur der Refresh Token rotiert.
- Access Tokens werden weiterhin gegen den JKT des Public Keys geprüft.
- Mehrere CLI-Prozesse werden wie bisher gegen konkurrierende Refresh-Rotation geschützt.

### Logout

- Refresh Token wird nach Möglichkeit remote widerrufen.
- Generic-Password-Session und Secure-Enclave-Schlüssel werden lokal gelöscht.
- Fehler beim Widerruf und Fehler beim lokalen Löschen werden getrennt behandelt und verständlich gemeldet.
- Wiederholtes Logout ist idempotent.
- Verwaiste Schlüssel können sicher erkannt und über einen expliziten Reparatur-/Cleanup-Befehl entfernt werden.

## Migration bestehender Sessions

Bestehende `StoredCredentials` enthalten einen exportierbaren privaten JWK. Dieser Schlüssel kann nicht in die Secure Enclave übernommen werden.

Deshalb gilt:

1. Alte Credentials anhand einer expliziten Schema-Version erkennen.
2. Bestehenden Refresh Token sicher widerrufen.
3. Alten Keychain-Eintrag löschen.
4. Benutzer zu einem neuen Login auffordern.
5. Beim neuen Login ein Secure-Enclave-Schlüsselpaar erzeugen.

Eine transparente Schlüsselrotation unter Beibehaltung des alten Refresh Tokens ist nicht zulässig, weil Refresh Token und Access Tokens an den bisherigen JKT gebunden sind.

Die Migration darf den alten privaten JWK oder Refresh Token nicht protokollieren oder in Backup-/Temporärdateien schreiben.

## Plattformen und Fallback

Vor der Implementierung ist eine Produktentscheidung erforderlich:

- Ist Secure Enclave für die macOS-CLI verpflichtend?
- Wird auf Macs ohne verfügbare Secure Enclave ein nicht exportierbarer Software-Keychain-`SecKey` verwendet?
- Darf explizit ein exportierbarer JWK-Fallback aktiviert werden?
- Wie funktionieren Linux, Windows, Container und CI?

Empfohlene Policy:

1. Secure Enclave verwenden, wenn verfügbar.
2. Einen dokumentierten, nicht exportierbaren OS-Key-Provider je Plattform anstreben.
3. Exportierbaren JWK-Fallback niemals still verwenden; er muss explizit konfiguriert und sichtbar gewarnt werden.
4. Tests verwenden einen injizierbaren In-Memory-Signer, nicht produktive Keychain-Secrets.

Der Key Provider wird im Credential-Schema gespeichert, damit die CLI beim Laden nicht raten muss.

## Packaging und Distribution

Die Task hängt von `cli-productization.md` ab. Das veröffentlichte CLI-Artefakt muss:

- das Native Addon bzw. den Swift-Helper für `arm64` und alle unterstützten macOS-Architekturen enthalten,
- korrekt code-signed und notarisiert sein,
- `Security.framework` ohne private APIs verwenden,
- keine temporär extrahierten unsignierten Helper starten,
- Updates ermöglichen, ohne den vorhandenen Secure-Enclave-Schlüssel zu verlieren,
- verständlich diagnostizieren, wenn Native Bridge, Architektur oder Signatur nicht kompatibel sind.

Die Installationsdokumentation beschreibt Hardware-/macOS-Anforderungen sowie das Verhalten bei Gerätewechsel und Wiederherstellung.

## Sicherheitsanforderungen

- Der private Schlüssel ist als nicht exportierbar erzeugt und wird nie als JWK `d` verfügbar.
- Native API und IPC geben ausschließlich Public Key, Key-ID und Signatur zurück.
- Signiert wird nur der exakt übergebene JWS Signing Input; Eingabegrößen sind begrenzt.
- Key-IDs und Application Tags werden nicht aus unvalidierten Serverdaten übernommen.
- Public Key und gespeicherter JKT werden beim Laden gegeneinander validiert.
- Fehler enthalten weder Keychain-Inhalt noch Token oder Signing Input mit sensitiven Claims.
- Native Speicher- und Ownership-Regeln werden auf Use-after-free, Buffer Overflows und unerwartete Unicode-/Nullbyte-Eingaben geprüft.
- Die Bridge akzeptiert nur P-256 und ECDSA mit SHA-256.
- Algorithmusverwechslungen bzw. vom Server gesteuerte Algorithmen sind ausgeschlossen.
- Die Trust Boundary und der verbleibende Schutz gegen lokale Malware werden dokumentiert.

## Tests

### Plattformunabhängig

- Signer-Abstraktion erzeugt gültige DPoP Compact JWS.
- Public JWK und JKT entsprechen dem verwendeten Signer.
- DER-zu-JOSE-Konvertierung deckt führende Nullbytes, kleine Werte, Überlänge und ungültiges DER ab.
- Proofs bestehen die bestehende `verifyStrictDpop()`-Prüfung.
- `ath`, `htm`, `htu`, `iat` und `jti` bleiben unverändert korrekt.
- Alte Credential-Version wird erkannt und nicht unsicher weiterverwendet.

### macOS-Integration

- Schlüssel wird erzeugt, gefunden, zum Signieren verwendet und gelöscht.
- Private External Representation ist nicht exportierbar.
- Public Key lässt sich korrekt als JWK exportieren.
- Mehrere Signaturen verwenden denselben Schlüssel und JKT.
- Fehlende oder gelöschte Key-Referenz führt zu einer verständlichen Neuanmeldung.
- Abgebrochener Login hinterlässt keinen verwaisten Schlüssel.
- Logout entfernt Session und Schlüssel.
- Signiertes Distributionsartefakt funktioniert auf allen unterstützten Mac-Architekturen.

Secure-Enclave-Integrationstests benötigen geeignete echte Hardware und werden getrennt von normalen Unit Tests gekennzeichnet. CI darf keine produktiven Benutzer-Credentials voraussetzen.

## Akzeptanzkriterien

- Ein Login auf unterstütztem macOS erzeugt einen nicht exportierbaren P-256-Schlüssel in der Secure Enclave.
- Der Keychain-Session-Eintrag enthält kein `privateJwk` und kein Feld `d` mehr.
- Alle DPoP-Proofs werden über eine Signer-Abstraktion mit `SecKeyCreateSignature` erstellt.
- DER-Signaturen werden strikt und getestet in das JOSE-ES256-Format konvertiert.
- Public JWK, JKT, Access-Token-Bindung und bestehende DPoP-Verifikation bleiben kompatibel.
- Refreshes verwenden dasselbe Schlüsselpaar; nur der Refresh Token rotiert.
- Login-Fehler und Logout hinterlassen keine unkontrollierten Schlüsselreste.
- Bestehende exportierbare Sessions werden sicher erkannt, widerrufen und durch einen neuen Login migriert.
- Verhalten auf nicht unterstützten Macs und anderen Plattformen ist explizit, dokumentiert und niemals ein stiller unsicherer Fallback.
- Native Bridge und CLI-Artefakt sind code-signed, paketiert und auf unterstützten Architekturen getestet.
