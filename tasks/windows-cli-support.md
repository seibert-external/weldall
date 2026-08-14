# Windows support for the CLI

## Goal

Make `@weldall/cli` a supported Windows CLI without weakening its OAuth, DPoP, or credential-storage guarantees.

## Scope

- Add a platform abstraction for opening the browser, storing the selected issuer, credential storage, and filesystem paths.
- Use Windows Credential Manager for sessions; never fall back to plaintext credential files.
- Replace macOS-only `open` and `defaults` calls with tested Windows implementations while preserving the loopback login flow.
- Verify locking, permissions, terminal output, path handling, signals, and `NO_COLOR` behavior on PowerShell and `cmd.exe`.
- Publish and document supported Windows/Node architectures; remove the npm `darwin` restriction only when Windows CI passes.
- Add Windows CI for build, unit tests, package verification, login callback behavior, and an install smoke test.

## Acceptance criteria

- A clean Windows installation can run `weldall --version`, configure an issuer, log in, make a request, and log out.
- Refresh tokens and DPoP key material are stored through Windows Credential Manager and are removed on logout.
- Browser launch and loopback callbacks work without shell interpolation or quoting vulnerabilities.
- macOS behavior remains unchanged, and platform-specific failures include actionable messages.
- The README and package metadata accurately list supported Windows versions and architectures.
