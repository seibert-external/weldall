---
"@weldall/weldall": minor
"@weldall/cli": patch
---

Offer Google Chat permissions on Google connectors to list spaces (`chat.spaces.readonly`), read messages (`chat.messages.readonly`) and send messages (`chat.messages.create`), and allow the Chat API origin. Editing or deleting messages and managing spaces or members stay unavailable. Accept the scopes in connector IaC configuration and the manifest JSON schema.
