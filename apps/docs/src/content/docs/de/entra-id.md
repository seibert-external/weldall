---
title: "How to: Mit Microsoft Entra ID anmelden"
description: Weldall in einem Microsoft-Entra-ID-Tenant registrieren und als Login-Provider für die Mitarbeitenden dieses Tenants anbinden.
sidebar:
  label: "How to: Entra ID"
---

Diese Anleitung registriert Weldall als Anwendung in einem Microsoft-Entra-ID-Tenant und bindet den Tenant als Login-Provider an. Danach melden sich die Mitarbeitenden dieses Tenants mit ihrem Microsoft-Arbeitskonto bei Weldall an.

Weldall verknüpft Konten über die E-Mail-Adresse und macht Scopes an ihr fest. Deshalb akzeptiert Weldall eine Anmeldung über Entra ID nur, wenn Microsoft die E-Mail-Adresse als vom Domain-Inhaber verifiziert kennzeichnet. Die meisten Schritte unten sorgen dafür, dass Entra ID diese Bestätigung mitschickt.

## Bevor du beginnst

- Eine Rolle im Tenant, die App-Registrierungen anlegen und bearbeiten darf, zum Beispiel Cloud Application Administrator oder Application Administrator.
- Die Tenant-ID: Im [Microsoft Entra Admin Center](https://entra.microsoft.com) zeigt **Entra ID** > **Overview** sie als **Tenant ID** an. Die Beispiele verwenden `00000000-0000-0000-0000-000000000000`.
- Alle Mitarbeitenden, die sich anmelden, haben eine E-Mail-Adresse (Attribut `mail`) in einer Domain, die im Tenant verifiziert ist.
- Die [Azure CLI](https://learn.microsoft.com/de-de/cli/azure/) oder den [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer) für einen Microsoft-Graph-Request in Schritt 4.
- Eine Weldall-Instanz unter ihrer öffentlichen URL, hier `https://weldall.example.com`. Den Provider trägst du entweder im [Installer](../installer/) ein oder, bei einer laufenden Instanz, in der Administrationsoberfläche unter **Login providers** > **Add login provider**. Beide Formulare zeigen die Callback-URL, die du in Schritt 1 brauchst.

## Einschränkungen

- **Ein Tenant pro Provider.** Weldall unterstützt nur tenant-gebundene Issuer. `/common`, `/organizations` und `/consumers` werden nicht unterstützt.
- **Nur Mitglieder.** Gastkonten (B2B) werden abgelehnt, auch wenn sie in den Tenant eingeladen sind.
- **Nur die globale Azure-Cloud.** Weldall erkennt Entra ID nur unter `login.microsoftonline.com`. Nationale Clouds wie Azure Government oder Azure operated by 21Vianet werden nicht unterstützt.
- **E-Mail-Adresse erforderlich.** Mitarbeitende ohne `mail`-Attribut oder mit einer Adresse in einer nicht verifizierten Domain können sich nicht anmelden.

## 1. Anwendung registrieren

1. Öffne im Microsoft Entra Admin Center **Entra ID** > **App registrations** > **New registration**.
2. Gib einen Namen ein, zum Beispiel `Weldall`. Wähle unter **Supported account types** die Option **Single tenant only**.
3. Wähle **Register**. Die Seite **Overview** zeigt die **Application (client) ID**; Weldall braucht sie als Client-ID.
4. Öffne **Authentication**, wähle **Add Redirect URI**, dann die Plattform **Web**, und trage die Callback-URL aus dem Weldall-Formular ein, zum Beispiel:

   ```text
   https://weldall.example.com/api/auth/callback/00000000-0000-4000-8000-000000000001
   ```

   Der Installer zeigt immer diese URL. Ein Provider, den du später unter **Login providers** anlegst, bekommt eine eigene ID und damit eine andere URL; kopiere sie aus diesem Formular. Entra ID verlangt die exakte URL.

5. Öffne **API permissions** > **Add a permission** > **Microsoft Graph** > **Delegated permissions**, füge `openid`, `profile` und `email` hinzu und wähle dann **Grant admin consent for &lt;tenant&gt;**. Sonst fragt Entra ID alle Mitarbeitenden bei der ersten Anmeldung nach ihrer Zustimmung zu `openid`, `profile` und `email` oder blockiert die Anmeldung, wenn die Benutzerzustimmung eingeschränkt ist. Dafür brauchst du zum Beispiel die Rolle Cloud Application Administrator oder Application Administrator; siehe [Mandantenweite Administratorzustimmung erteilen](https://learn.microsoft.com/de-de/entra/identity/enterprise-apps/grant-admin-consent).

## 2. Client-Secret anlegen

1. Öffne **Certificates & secrets** > **Client secrets** > **New client secret**.
2. Gib eine Beschreibung ein und wähle die Laufzeit. Entra ID erlaubt höchstens 24 Monate; Microsoft empfiehlt weniger als 12.
3. Kopiere den **Value** sofort. Entra ID zeigt ihn nie wieder an. Bewahre ihn im Passwortmanager auf, bis du ihn in Weldall einträgst.

Microsoft empfiehlt Zertifikate statt Client-Secrets, und manche Tenants verbieten Client-Secrets per Richtlinie. Weldall unterstützt derzeit nur Client-Secrets; Zertifikate und Federated Credentials werden nicht unterstützt. Läuft das Secret ab, kann sich niemand mehr über diesen Provider anmelden. Notiere das Ablaufdatum und tausche das Secret rechtzeitig aus:

1. Lege in Entra ID ein zweites Secret an, solange das erste noch gilt.
2. Öffne in Weldall den Provider unter **Login providers**, trage den neuen Wert unter **Client secret** ein, führe **Test login** aus und speichere.
3. Lösche das alte Secret in Entra ID.

## 3. Optionale Claims hinzufügen

Entra ID sendet kein `email_verified`. Stattdessen gibt der optionale Claim `xms_edov` an, ob der Domain-Inhaber der E-Mail-Adresse verifiziert ist. Weldall braucht drei optionale Claims im ID-Token:

| Claim      | Zweck                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------ |
| `email`    | Die Adresse, die Weldall als Identität verwendet. `xms_edov` kommt nur zusammen mit ihr.   |
| `xms_edov` | `true`, wenn die Adresse zu einer im Tenant verifizierten Domain gehört.                   |
| `acct`     | Pflicht. `0` für Mitglieder, `1` für Gäste. Weldall lehnt Gäste und Tokens ohne `acct` ab. |

Öffne **Token configuration** > **Add optional claim**, wähle den Tokentyp **ID** und füge `email`, `xms_edov` und `acct` hinzu.

Steht `xms_edov` nicht in der Liste, trage die Claims stattdessen im Manifest ein. Öffne **Manifest** und setze `idToken` innerhalb von `optionalClaims`; vorhandene Einträge bleiben erhalten:

```json
"optionalClaims": {
  "idToken": [
    { "name": "email", "essential": false },
    { "name": "xms_edov", "essential": false },
    { "name": "acct", "essential": false }
  ]
}
```

Wähle **Save**. Microsoft beschreibt die Claims in der [Referenz der optionalen Claims](https://learn.microsoft.com/de-de/entra/identity-platform/optional-claims-reference) und das Manifest-Format unter [Optionale Claims konfigurieren](https://learn.microsoft.com/de-de/entra/identity-platform/optional-claims).

## 4. Unverifizierte E-Mail-Adressen entfernen

Bei Single-Tenant-Apps schreibt Entra ID standardmäßig auch E-Mail-Adressen mit nicht verifiziertem Domain-Inhaber ins Token. Die Anwendungseigenschaft `authenticationBehaviors.removeUnverifiedEmailClaim` schaltet das ab. Weldall lehnt solche Adressen bereits über `xms_edov` ab; die Einstellung sorgt dafür, dass sie Weldall gar nicht erst erreichen.

Setze sie über Microsoft Graph, zum Beispiel mit der Azure CLI. Ersetze die Client-ID durch die **Application (client) ID** aus Schritt 1:

```sh
az login --tenant 00000000-0000-0000-0000-000000000000 --allow-no-subscriptions
CLIENT_ID=11111111-1111-1111-1111-111111111111
az rest --method patch \
  --url "https://graph.microsoft.com/v1.0/applications(appId='${CLIENT_ID}')" \
  --body '{"authenticationBehaviors": {"removeUnverifiedEmailClaim": true}}'
az rest --method get \
  --url "https://graph.microsoft.com/v1.0/applications(appId='${CLIENT_ID}')/authenticationBehaviors"
```

Der letzte Befehl zeigt `"removeUnverifiedEmailClaim": true`. Dieselben Requests funktionieren auch im [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer). Microsoft beschreibt die Einstellung unter [Manage application authenticationBehaviors](https://learn.microsoft.com/en-us/graph/applications-authenticationbehaviors).

## 5. Provider in Weldall eintragen

Fülle den Installer oder das Formular unter **Login providers** aus:

| Feld                          | Wert                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Exact HTTPS issuer            | `https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0` mit deiner Tenant-ID in Kleinbuchstaben. |
| Discovery URL override        | Leer.                                                                                                                  |
| Client ID                     | Die **Application (client) ID**.                                                                                       |
| Client secret                 | Der **Value** des Secrets aus Schritt 2.                                                                               |
| Token endpoint authentication | `client_secret_post` oder `client_secret_basic`. Entra ID akzeptiert beides.                                           |
| Scopes                        | `openid profile email` beibehalten.                                                                                    |
| Allowed email domains         | Immer die Domains deiner Organisation, zum Beispiel `example.com`.                                                     |

Der Issuer muss die Tenant-ID enthalten, keinen Domainnamen. Weldall vergleicht ihn exakt mit dem Issuer im Discovery-Dokument, und Entra ID veröffentlicht diesen Issuer mit der Tenant-ID. Nur Issuer genau dieser Form erhalten die hier beschriebenen Entra-ID-Regeln. Jeder andere Issuer, auch die v1.0-Form `https://sts.windows.net/<tenant>/`, gilt als generischer OIDC-Provider und scheitert, weil Entra ID kein `email_verified` sendet.

Nach dem Speichern lässt sich der Issuer nicht mehr ändern. Um ihn zu korrigieren, lege unter **Login providers** einen neuen Provider an und trage dessen Callback-URL in Entra ID ein.

`Allowed email domains` beschränkt Weldall auf die Adressen, die du erwartest, auch wenn der Tenant später weitere Domains verifiziert.

Führe **Test login** mit einem Konto des Tenants aus, bevor du speicherst oder die Installation abschließt.

## Fehlerbehebung

Für drei Entra-ID-Regeln zeigt die Anmeldeseite eine eigene Meldung:

| Meldung                                                                                                                                                                                                    | Bedeutung und wahrscheinliche Ursachen                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| „Microsoft Entra ID did not confirm a verified email address for your account. Ask your administrator to check the optional claims of the Weldall app registration and the email address of your account.“ | Das ID-Token enthielt kein `xms_edov` mit dem Wert `true`. In der App-Registrierung fehlen die optionalen Claims `email` oder `xms_edov` (Schritt 3), das Konto hat kein `mail`-Attribut, oder die Adresse liegt in einer Domain, die im Tenant nicht verifiziert ist. |
| „Microsoft Entra ID did not send the claims Weldall needs. Ask your administrator to add the optional claims email, xms_edov and acct to the Weldall app registration.“                                    | Das ID-Token enthielt keinen `acct`-Claim. Füge den optionalen Claim `acct` in der App-Registrierung hinzu (Schritt 3).                                                                                                                                                |
| „Guest accounts cannot sign in. Sign in with a member account of your organization.“                                                                                                                       | Das Konto ist Gast im Tenant: `acct` ist nicht `0`, oder `idp` nennt einen anderen Identity Provider. Melde dich mit einem Mitgliedskonto des Tenants an.                                                                                                              |

Jede andere Ablehnung zeigt die allgemeine Meldung „Login failed. Please retry or contact your administrator.“ Häufige Ursachen: Die Callback-URL stimmt nicht exakt, der Issuer hat die falsche Form, das Client-Secret ist abgelaufen, oder die Adresse liegt außerhalb von **Allowed email domains**.

**Test login** im Installer und in der Administrationsoberfläche zeigt diese Meldungen nicht. Es meldet nur, dass der Test fehlgeschlagen ist. Prüfe die Konfiguration in dieser Reihenfolge: Callback-URL, Issuer, Client-Secret, optionale Claims, dann das Testkonto (Mitglied, `mail`-Attribut, verifizierte Domain). Im Installer muss das Testkonto der angegebene erste Administrator sein. Um die Domain-Liste auszuschließen, vergleiche die Domain im `mail`-Attribut des Testkontos mit **Allowed email domains**. Weldall vergleicht exakte Domains; eine Subdomain braucht einen eigenen Eintrag.
