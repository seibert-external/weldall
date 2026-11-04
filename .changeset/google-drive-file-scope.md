---
"@weldall/weldall": minor
"@weldall/cli": patch
---

Offer Google Drive read-only (`drive.readonly`), Google Sheets (`spreadsheets`) and Google Docs (`documents`) permissions on Google connectors, and allow the Sheets and Docs API origins, so a connection can list and read Drive files and read and edit spreadsheets and documents. Full Drive access stays unavailable. Accept the scopes in connector IaC configuration and the manifest JSON schema.
