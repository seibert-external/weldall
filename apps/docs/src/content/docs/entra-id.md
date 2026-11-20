---
title: "How to: Sign in with Microsoft Entra ID"
description: Register Weldall in a Microsoft Entra ID tenant and connect it as a login provider for the employees of that tenant.
sidebar:
  label: "How to: Entra ID"
---

This guide registers Weldall as an application in one Microsoft Entra ID tenant and connects it as a login provider. Afterwards, the employees in that tenant sign in to Weldall with their Microsoft work accounts.

Weldall links accounts by email address and maps scopes to it. It therefore accepts an Entra ID sign-in only when Microsoft marks the email address as verified by the domain owner. Most steps below exist to make Entra ID send that confirmation.

## Before you start

- A role in the tenant that can create and edit app registrations, for example Cloud Application Administrator or Application Administrator.
- The tenant ID: **Entra ID** > **Overview** in the [Microsoft Entra admin center](https://entra.microsoft.com) shows it as **Tenant ID**. The examples use `00000000-0000-0000-0000-000000000000`.
- Every employee who signs in has an email address (the `mail` attribute) in a domain that is verified in the tenant.
- The [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/) or [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer) for one Microsoft Graph request in step 4.
- A Weldall instance at its public URL, here `https://weldall.example.com`. You enter the provider either in the [installer](../installer/) or, on a running instance, under **Login providers** > **Add login provider** in the administration interface. Both forms show the callback URL you need in step 1.

## Limitations

- **One tenant per provider.** Weldall supports tenant-bound issuers only. `/common`, `/organizations` and `/consumers` are not supported.
- **Members only.** Guest accounts (B2B) are rejected, even when they are invited to the tenant.
- **Global Azure cloud only.** Weldall recognizes Entra ID only on `login.microsoftonline.com`. National clouds such as Azure Government or Azure operated by 21Vianet are not supported.
- **Email address required.** Employees without a `mail` attribute, or with an address in an unverified domain, cannot sign in.

## 1. Register the application

1. In the Microsoft Entra admin center, open **Entra ID** > **App registrations** > **New registration**.
2. Enter a name, for example `Weldall`. Under **Supported account types**, select **Single tenant only**.
3. Select **Register**. The **Overview** page shows the **Application (client) ID**; Weldall needs it as the client ID.
4. Open **Authentication**, select **Add Redirect URI**, choose the **Web** platform and enter the callback URL from the Weldall form, for example:

   ```text
   https://weldall.example.com/api/auth/callback/00000000-0000-4000-8000-000000000001
   ```

   The installer always shows this URL. A provider added later under **Login providers** gets its own ID and therefore a different URL; copy it from that form. Entra ID requires the exact URL.

5. Open **API permissions** > **Add a permission** > **Microsoft Graph** > **Delegated permissions**, add `openid`, `profile` and `email`, then select **Grant admin consent for &lt;tenant&gt;**. Otherwise Entra ID asks every employee to consent to `openid`, `profile` and `email` at the first sign-in, or blocks the sign-in if user consent is restricted. This requires, for example, the Cloud Application Administrator or Application Administrator role; see [Grant tenant-wide admin consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent).

## 2. Create a client secret

1. Open **Certificates & secrets** > **Client secrets** > **New client secret**.
2. Enter a description and choose an expiry. Entra ID allows at most 24 months; Microsoft recommends less than 12.
3. Copy the **Value** right away. Entra ID never shows it again. Store it in your password manager until you enter it in Weldall.

Microsoft recommends certificates over client secrets, and some tenants block client secrets by policy. Weldall currently supports only client secrets; certificates and federated credentials are not supported. Once the secret expires, nobody can sign in through this provider. Note the expiry date and rotate the secret in time:

1. Create a second secret in Entra ID while the first one is still valid.
2. In Weldall, open the provider under **Login providers**, enter the new value in **Client secret**, run **Test login** and save.
3. Delete the old secret in Entra ID.

## 3. Add the optional claims

Entra ID does not send `email_verified`. Instead, the optional claim `xms_edov` states whether the domain owner of the email address is verified. Weldall needs three optional claims in the ID token:

| Claim      | Purpose                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------- |
| `email`    | The address Weldall uses as identity. `xms_edov` is only sent together with it.              |
| `xms_edov` | `true` when the address belongs to a domain verified in the tenant.                          |
| `acct`     | Required. `0` for members, `1` for guests. Weldall rejects guests and tokens without `acct`. |

Open **Token configuration** > **Add optional claim**, select the token type **ID** and add `email`, `xms_edov` and `acct`.

If `xms_edov` is not offered in the list, add the claims in the manifest instead. Open **Manifest** and set `idToken` inside `optionalClaims`; keep any entries that are already there:

```json
"optionalClaims": {
  "idToken": [
    { "name": "email", "essential": false },
    { "name": "xms_edov", "essential": false },
    { "name": "acct", "essential": false }
  ]
}
```

Select **Save**. Microsoft documents the claims in the [optional claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference) and the manifest format in [Configure optional claims](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims).

## 4. Remove unverified email addresses

For single-tenant apps, Entra ID by default still puts email addresses with an unverified domain owner into the token. The application property `authenticationBehaviors.removeUnverifiedEmailClaim` turns that off. Weldall already rejects such addresses through `xms_edov`; the setting makes sure they never reach Weldall in the first place.

Set it with Microsoft Graph, for example with the Azure CLI. Replace the client ID with the **Application (client) ID** from step 1:

```sh
az login --tenant 00000000-0000-0000-0000-000000000000 --allow-no-subscriptions
CLIENT_ID=11111111-1111-1111-1111-111111111111
az rest --method patch \
  --url "https://graph.microsoft.com/v1.0/applications(appId='${CLIENT_ID}')" \
  --body '{"authenticationBehaviors": {"removeUnverifiedEmailClaim": true}}'
az rest --method get \
  --url "https://graph.microsoft.com/v1.0/applications(appId='${CLIENT_ID}')/authenticationBehaviors"
```

The last command shows `"removeUnverifiedEmailClaim": true`. The same requests work in [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer). Microsoft describes the setting in [Manage application authenticationBehaviors](https://learn.microsoft.com/en-us/graph/applications-authenticationbehaviors).

## 5. Enter the provider in Weldall

Fill in the installer or the **Login providers** form:

| Field                         | Value                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Exact HTTPS issuer            | `https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0` with your tenant ID in lowercase. |
| Discovery URL override        | Empty.                                                                                                          |
| Client ID                     | The **Application (client) ID**.                                                                                |
| Client secret                 | The secret **Value** from step 2.                                                                               |
| Token endpoint authentication | `client_secret_post` or `client_secret_basic`. Entra ID accepts both.                                           |
| Scopes                        | Keep `openid profile email`.                                                                                    |
| Allowed email domains         | Always set the domains of your organization, for example `example.com`.                                         |

The issuer must contain the tenant ID, not a domain name. Weldall compares it exactly with the issuer in the discovery document, and Entra ID publishes that issuer with the tenant ID. Only issuers of this exact form receive the Entra ID rules described here. Any other issuer, including the v1.0 form `https://sts.windows.net/<tenant>/`, is treated as a generic OIDC provider and fails because Entra ID sends no `email_verified`.

The issuer cannot be changed after the provider is saved. To correct it, add a new provider under **Login providers** and register its callback URL in Entra ID.

`Allowed email domains` limits Weldall to the addresses you expect, even if the tenant later verifies further domains.

Run **Test login** with an account of the tenant before you save or complete the installation.

## Troubleshooting

The login page shows a specific message for three Entra ID rules:

| Message                                                                                                                                                                                                    | Meaning and likely causes                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Microsoft Entra ID did not confirm a verified email address for your account. Ask your administrator to check the optional claims of the Weldall app registration and the email address of your account." | The ID token had no `xms_edov` with the value `true`. The optional claims `email` or `xms_edov` are missing from the app registration (step 3); the account has no `mail` attribute; or the address is in a domain that is not verified in the tenant. |
| "Microsoft Entra ID did not send the claims Weldall needs. Ask your administrator to add the optional claims email, xms_edov and acct to the Weldall app registration."                                    | The ID token had no `acct` claim. Add the optional claim `acct` to the app registration (step 3).                                                                                                                                                      |
| "Guest accounts cannot sign in. Sign in with a member account of your organization."                                                                                                                       | The account is a guest in the tenant: `acct` is not `0`, or `idp` names a different identity provider. Sign in with a member account of the tenant.                                                                                                    |

Every other rejection shows the generic message "Login failed. Please retry or contact your administrator." Common causes: the callback URL does not match exactly, the issuer has the wrong form, the client secret expired, or the address is outside **Allowed email domains**.

**Test login** in the installer and in the administration interface does not show these messages. It only reports that the test failed. Check the configuration in this order: callback URL, issuer, client secret, optional claims, then the test account (member, `mail` attribute, verified domain). In the installer, the test account must be the nominated first administrator. To rule out the domain list, compare the domain of the test account's `mail` attribute with **Allowed email domains**. Weldall compares exact domains, so a subdomain needs its own entry.
