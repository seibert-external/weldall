---
"@weldall/weldall": minor
"@weldall/cli": patch
---

Offer Google Drive per-file (`drive.file`) and read-only (`drive.readonly`), Google Sheets (`spreadsheets.readonly`, `spreadsheets`) and Google Docs (`documents.readonly`, `documents`) permissions on Google connectors, and allow the Sheets and Docs API origins, so a connection can read Drive files and read and edit existing spreadsheets and documents. Full Drive access stays unavailable. Accept the scopes in connector IaC configuration and the manifest JSON schema.
