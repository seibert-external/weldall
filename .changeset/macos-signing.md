---
"@weldall/cli": patch
---

Sign the macOS standalone executables with the Seibert Developer ID certificate and notarize them with Apple in the release workflow. Gatekeeper now runs a downloaded `weldall` binary without a warning, so the `xattr -d com.apple.quarantine` step is gone from the install instructions, and the saved session stays readable across CLI upgrades because the keychain trusts the signing identity rather than one specific build.
