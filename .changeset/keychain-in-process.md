---
"@weldall/cli": minor
---

Store the saved session through the operating system's credential service in-process on every runtime, including the standalone macOS executable, which previously went through `/usr/bin/security`. On macOS the keychain item is now created by the CLI itself, so only the Weldall executable can read it without a prompt; the standalone build is re-signed after compiling so the darwin-x64 executable gets a valid code identity too. After upgrading from an npm install or an older standalone build on macOS, run `weldall login` once more.
