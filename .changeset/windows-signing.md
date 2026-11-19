---
"@weldall/cli": patch
---

Sign the Windows standalone executable (`weldall.exe` in the `windows-x64` zip) with Authenticode through Azure Artifact Signing in the release workflow. Until now it shipped unsigned, which Windows Smart App Control blocks.
