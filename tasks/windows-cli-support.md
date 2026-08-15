# Cross-platform CLI support, CI, and standalone Bun distribution

## Status

Implemented in this PR: cross-platform runtime behavior, native source/packed/standalone CI matrices, exact-tag standalone release assets with retry-safe upload, release gating, documentation, and a minor CLI Changeset. The shared packed/standalone harness also runs a controlled authenticated OAuth/DPoP session, binary transfers, process-lock contention, logout/revocation, and machine-authenticated IaC plan/state flows through the real artifact. Native Windows, Linux x64, and macOS Intel execution remains the pull-request CI verification boundary.

The artifact harness captures JSON/plain non-TTY output through child-process pipes and separately starts each packed and standalone artifact in a native PTY (ConPTY on Windows) to verify Ink rendering, terminal color, and `NO_COLOR`. Its authenticated transfer flow also sends terminal Ctrl-C during a partial download on every native OS and proves the previous destination survives, temporary debris is removed, and the terminal process exits.

This plan supersedes the narrower Windows-only task that previously lived in this file.

## Decision

Ship the same CLI source through two independent channels:

1. **The existing JavaScript npm package** (`@weldall/cli`) for users who already have Node.js.
2. **Standalone executables built with Bun** for users who should not need Node.js, npm, Bun, or `node_modules`.

The npm package remains a normal JavaScript CLI. Do **not** turn it into a launcher for platform binary packages and do not make Bun a runtime dependency of the npm installation.

Support the complete CLI on Ubuntu, macOS, and Windows. Run the complete CLI-specific test suite on native CI runners for every supported OS. Keep the monorepo database, Docker, web application, and Playwright system suite on Linux; reproducing that whole server stack on macOS and Windows would add cost without testing additional client behavior.

Code signing, Apple notarization, Windows Authenticode signing, WinGet, Homebrew, MSIX, and installer work are explicitly deferred. Initial standalone assets will therefore be unsigned GitHub Release downloads and must be documented as such.

## Goals

- Make every CLI command work on supported Ubuntu, macOS, and Windows installations.
- Preserve the simple `npm install --global @weldall/cli` path on all supported operating systems.
- Produce self-contained Bun executables that do not require a JavaScript runtime on the customer machine.
- Exercise source, packed npm artifacts, native integrations, and standalone binaries on native CI runners.
- Preserve OAuth, DPoP, system-CA, credential-storage, issuer-selection, and filesystem safety guarantees.
- Publish reproducible, versioned standalone archives and checksums alongside Changesets-created GitHub releases.
- Keep the npm and standalone builds derived from one source tree and one package version.

## Non-goals

- Rewriting the CLI in Go, Rust, or another language.
- Replacing the npm package with platform-specific npm wrapper packages.
- Migrating the application runtime to Bun for development, unit testing, or npm distribution.
- Running the entire Docker/database/web Playwright stack on macOS or Windows.
- Supporting Alpine/musl, Windows ARM64, or Linux ARM64 in the first release.
- Adding self-update behavior to the CLI.
- Falling back to plaintext files for refresh tokens, DPoP private keys, or other credentials.
- Signing, notarizing, publishing package-manager manifests, or creating installers in this task.

## Current state and known platform blockers

The implementation must start by reading the current authoritative files rather than relying only on this plan:

- `apps/cli/package.json`
- `apps/cli/scripts/build.mjs`
- `apps/cli/scripts/verify-package.mjs`
- `apps/cli/src/index.ts`
- `apps/cli/src/services/auth.ts`
- `apps/cli/src/storage/preferences.ts`
- `apps/cli/src/storage/keychain.ts`
- `apps/cli/src/storage/appendix.ts`
- `apps/cli/src/storage/lock.ts`
- `.github/workflows/ci.yml`
- `apps/e2e/test/system.spec.ts`

Pre-implementation blockers (historical; resolved by the implementation described above):

1. `apps/cli/package.json` restricts npm installation to `darwin` and `linux` and describes macOS/Linux-only behavior.
2. Browser launch is hard-coded to the macOS `open` executable in `apps/cli/src/services/auth.ts`.
3. Issuer persistence is hard-coded to `/usr/bin/defaults` and throws outside macOS in `apps/cli/src/storage/preferences.ts`.
4. The README describes native user sessions as macOS-only.
5. The packed-artifact CI matrix covers Ubuntu and macOS, not Windows.
6. Package verification asserts the old OS restriction and Unix executable behavior.
7. Existing shell snippets in CI use Unix paths, globs, and executable invocation and cannot simply be copied into PowerShell jobs.
8. The full application E2E suite invokes the CLI inside the Linux Docker environment and shadows the macOS `open` command through `PATH`; that is not a native Windows/macOS client test.

Most filesystem code already uses Node path and filesystem APIs. Existing tests should expose remaining differences in Windows path separators, atomic replacement, locking, permissions, temporary files, and terminal behavior.

## Credential storage

Continue using `@napi-rs/keyring`; do not introduce plaintext credential fallback.

Version 1.3.0 already publishes native packages for:

- macOS ARM64 and x64,
- Windows x64, ARM64, and ia32,
- Linux x64/ARM64 for glibc and musl, plus additional architectures.

Its current native implementation uses:

- Apple Keychain on macOS,
- Windows native credential storage on Windows,
- D-Bus Secret Service on Linux with a kernel keyutils fallback.

The npm package should retain `@napi-rs/keyring` as an optional dependency so IaC/help commands can still start when optional native dependencies are intentionally omitted. User-session commands must fail closed with an actionable error if secure credential storage is unavailable.

The standalone build must include only the target runner's native keyring binding. Build binaries on native runners rather than relying on Bun cross-compilation; this also makes the produced executable testable before publication.

## Issuer preference abstraction

Preserve the existing selection order:

1. `WELDALL_ISSUER` environment override,
2. persistent user preference,
3. interactive prompt.

Introduce a platform-neutral `IssuerPreferences` selection point.

Recommended first implementation:

- **macOS:** preserve the existing `defaults` domain and key so MDM and existing installations remain compatible.
- **Windows and Linux:** store the non-secret issuer in an atomically replaced user configuration file under the existing Weldall user directory or the platform's standard user configuration directory. Keep the chosen location stable and document it.
- Continue strict HTTPS-origin validation before storing an issuer.
- Never use the issuer file for credentials.
- Keep read/write/clear injectable for tests.

A Windows registry/Group Policy provider may be added later if customer deployment requirements justify it. `WELDALL_ISSUER` remains available to managed deployments in the first cross-platform release.

## Browser launch abstraction

Replace the hard-coded `open` call with an injectable browser opener that uses no shell interpolation:

- macOS: `open <url>` via `execFile`,
- Windows: a native URL opener invoked through `execFile` with the URL as a distinct argument,
- Linux: `xdg-open <url>` via `execFile`.

Do not construct `cmd.exe`, PowerShell, or POSIX shell command strings containing the authorization URL. Authorization URLs contain attacker-influenced metadata and query values and must remain argument-array data.

If the platform opener is unavailable, close the loopback listener and return an actionable error. Consider printing the sanitized authorization URL as an explicit manual fallback only if that behavior is deliberately designed and tested.

Keep the opener injectable so unit and black-box tests never open a real browser. Preserve the loopback callback security checks for exact issuer, state, path, result cardinality, and timeout.

## npm package path

Keep the current npm build based on `apps/cli/scripts/build.mjs` and esbuild. It should continue to produce `dist/index.js` with external npm dependencies and the Node shebang.

Required changes:

- Remove the `os` restriction only after the native platform CI is green.
- Update the package description and README to accurately describe all supported platforms.
- Preserve the minimum Node.js version unless a separate compatibility decision changes it.
- Preserve `#!/usr/bin/env -S node --use-system-ca` unless Windows artifact tests show a compatibility issue.
- Test the actual `.tgz`, not a directory/symlink install.
- Test npm's generated Windows `.cmd` and PowerShell shims on `windows-latest`.
- Keep the package free of workspace/file/link dependency specifiers and monorepo paths.

Current npm `cmd-shim` supports stripping `env -S` and forwarding shebang arguments, but the minimum supported Node/npm combination must prove this in CI. Do not assume behavior from the locally installed npm version.

## Standalone Bun build

Add a separate binary build script, preferably under `apps/cli/scripts/`, that is executed by an exactly pinned Bun version. Do not replace `build.mjs` or the npm package output.

The binary build must:

- compile from the CLI source entrypoint,
- embed the package version from `apps/cli/package.json`,
- bundle JavaScript dependencies and the target platform keyring addon,
- disable automatic `.env` and `bunfig.toml` loading,
- embed `--use-system-ca` through Bun's compiled executable `execArgv`,
- avoid bytecode initially to reduce additional runtime/version coupling,
- emit into a controlled temporary/output directory,
- remove intermediate `.bun-build` files and leave no repository artifacts,
- fail if the output binary version differs from the package version.

### Required Ink workaround

A plain Bun 1.3.14 compile of the current CLI fails because Ink 7.1.1 references the optional peer `react-devtools-core`. Installing it is not appropriate for a production binary, and marking it external caused the executable to fail at startup.

Use a small Bun build plugin that resolves `react-devtools-core` to an inert virtual module for the production executable. Keep the workaround narrow, comment why it exists, and add a test so an Ink/Bun upgrade cannot silently reintroduce startup failure. Re-evaluate and remove the workaround when upstream Ink/Bun no longer needs it.

Do not patch `node_modules` or apply generated bundle string replacements.

### Local proof-of-concept evidence

On 2026-08-15, with Bun 1.3.14 on macOS ARM64:

- plain compile failed on unresolved `react-devtools-core`,
- a virtual-module resolver plugin compiled 723 modules into a Mach-O ARM64 executable,
- the binary reported version `0.8.0`,
- root help and IaC help ran successfully,
- the binary ran from an unrelated working directory, which exercises Ink/Yoga embedded asset resolution,
- a separate compiled smoke executable embedded and loaded `@napi-rs/keyring` successfully.

Bun left large hidden `.bun-build` intermediates in the repository during exploratory builds; they were removed. The production build script must avoid or clean this behavior and CI should assert a clean working tree after packaging.

## Initial target matrix

Build and test these targets natively:

| Artifact target          | GitHub runner                          | Notes                                                          |
| ------------------------ | -------------------------------------- | -------------------------------------------------------------- |
| Linux x64 glibc baseline | `ubuntu-latest`                        | Ubuntu/customer default; use baseline CPU target for older VMs |
| Windows x64 baseline     | `windows-latest`                       | Primary Windows customer target; use baseline CPU target       |
| macOS ARM64              | `macos-15`                             | Apple Silicon                                                  |
| macOS x64                | `macos-15-intel` or current equivalent | Intel Macs and Rosetta-free native support                     |

Pin runner labels deliberately rather than assuming floating labels keep the same architecture forever.

Defer Linux ARM64, Linux musl/Alpine, and Windows ARM64 until required. The build target list should live in one authoritative script/data structure shared by packaging and release logic where practical.

## CI architecture

### 1. Existing Linux monorepo verification

Keep the existing root `verify`, database, build, and Playwright E2E jobs on the Linux `weldall` runner. They remain authoritative for the server and complete product flow.

Keep the minimum-Node compatibility check. Avoid multiplying the full monorepo suite across operating systems.

### 2. Native CLI source matrix

Add a CLI-focused matrix for Ubuntu, Windows, macOS ARM64, and macOS Intel. On every runner:

1. Install the exact pnpm and minimum supported Node.js versions.
2. Run `pnpm install --frozen-lockfile` so the correct optional keyring package is selected.
3. Run CLI typecheck.
4. Run the complete CLI Vitest suite, not a platform subset.
5. Build the npm artifact.
6. Run package verification.
7. Assert the repository has no generated/untracked build debris.

The current baseline is 10 CLI test files and 91 tests. The exact count may grow; CI should run the suite rather than assert this count.

### 3. Packed npm artifact matrix

On every native runner:

1. Produce an npm tarball with `npm pack`/`pnpm pack`.
2. Create a fresh temporary consumer project outside the monorepo.
3. Install the `.tgz`, never the source directory.
4. Invoke the generated `weldall` command through the platform's normal shell integration.
5. Verify `--version`, root help, representative subcommand help, and exit codes.
6. Run black-box config and IaC fixtures from paths containing spaces and non-ASCII characters.
7. On Windows, exercise both PowerShell and `cmd.exe` npm shims.
8. Run at least one installation with optional dependencies enabled and retain the existing omit-optional startup check for commands that do not need credentials.

Implement the smoke driver in Node/TypeScript instead of OS-specific shell snippets so path construction and archive discovery work on all platforms.

### 4. Standalone binary matrix

On every target runner:

1. Install an exactly pinned Bun version using a commit-pinned setup action.
2. Build only the runner's native target.
3. Verify file type/architecture where tooling is available.
4. Run the executable from a different working directory.
5. Verify version, root help, representative subcommand help, JSON output, exit codes, and terminal/non-terminal behavior.
6. Run config set/get/reset against an isolated home/config directory.
7. Run representative IaC validation/plan/state operations using temporary Windows and POSIX paths.
8. Verify locking and atomic output behavior.
9. Load the embedded keyring addon.
10. Perform a disposable secure-store set/get/delete round trip when the runner's credential service supports it, always cleaning up in `finally`.
11. Verify system-CA mode is active or exercise a local test CA trusted through the platform store where practical.
12. Assert no `node`, npm dependencies, Bun installation, source checkout, or current working directory is needed to start the copied artifact.

Tests that mutate a native credential store must use a unique service/account identifier derived from the CI run and must remove it even after failure. Linux CI may need D-Bus Secret Service setup; the keyring library can fall back to kernel keyutils, but the selected backend and failure behavior should be visible in test diagnostics.

### 5. Cross-platform black-box CLI flow

Create or extract a deterministic CLI integration harness that can execute either:

- the packed npm command under Node, or
- the standalone executable.

It should cover as much of the real command flow as possible without opening a real browser or depending on the production credential store:

- issuer selection and persistence,
- loopback callback validation,
- login token exchange against controlled metadata/endpoints,
- credential save/read/rotation through an injected test store,
- `whoami`, scopes, skills, and authenticated request behavior,
- upload/download and Windows path handling,
- logout and local cleanup,
- JSON/plain/TTY output behavior and error codes.

Reuse existing secure test hooks such as `WELDALL_E2E_CREDENTIALS_FILE` only under `NODE_ENV=test`; do not add a production plaintext-credential mode. Prefer explicit dependency injection for browser opening and preferences over manipulating shell `PATH` on every platform.

The existing Docker/Playwright test in `apps/e2e/test/system.spec.ts` remains the full real server/browser product E2E on Linux. The new native matrix is responsible for proving that the client artifact behaves correctly on each OS.

### 6. Release gating

The Changesets release job must depend on successful native CLI source, packed npm, and standalone build/smoke jobs in addition to the current gates. A release must not publish npm support for an OS or upload an executable target that did not execute successfully on a matching native runner.

## GitHub Release packaging

Continue using Changesets for versions, npm publication, tags, and GitHub releases.

Add a release-assets workflow or reusable workflow that:

1. Runs only for a release/tag corresponding to `@weldall/cli`.
2. Checks out the exact release tag, not moving `main`.
3. Builds the native matrix from that tag.
4. Confirms every binary's `--version` matches the release version.
5. Archives each executable with the repository license, a concise install/readme file, and required third-party notices.
6. Uses stable names such as:
   - `weldall-vX.Y.Z-linux-x64.tar.gz`
   - `weldall-vX.Y.Z-windows-x64.zip`
   - `weldall-vX.Y.Z-darwin-arm64.tar.gz`
   - `weldall-vX.Y.Z-darwin-x64.tar.gz`
7. Produces one `SHA256SUMS` file over the final archives.
8. Uploads all assets to the Changesets-created GitHub release.
9. Uses least-privilege `contents: write` only in the final upload job.
10. Is retry-safe and does not overwrite mismatched existing assets silently.

Account for how `changesets/action` creates scoped-package tags/releases and ensure the release event can trigger the asset workflow when `RELEASE_GITHUB_TOKEN` is used. Test this with a prerelease or dry-run path before relying on it for the first customer release.

Unsigned artifacts are acceptable for this phase, but the release notes and installation documentation must say they are unsigned. Do not publish WinGet/MSIX/Homebrew metadata until the corresponding signing and trust workflow is designed.

## Cross-platform behavior to test explicitly

- Windows path separators, drive letters, UNC/path edge handling where supported, spaces, and Unicode paths.
- Atomic replacement when the destination already exists.
- Lock contention and stale lock cleanup.
- File permissions on POSIX and safe best-effort behavior on Windows.
- Browser URL argument separation and no shell metacharacter interpretation.
- Loopback listener startup, callback validation, timeout, and cleanup.
- Windows Credential Manager, macOS Keychain, and Linux secure-store errors.
- `NO_COLOR`, TTY detection, redirected stdout/stderr, JSON output, and binary stdout.
- Ctrl-C/process termination behavior where the CLI owns a listener or file stream.
- npm invocation from PowerShell, `cmd.exe`, bash/zsh, and ordinary POSIX shells.
- Corporate/system CA behavior for both Node and embedded Bun runtimes.
- Running the standalone binary after copying it away from the repository and changing the working directory.
- No accidental loading of project `.env`, `bunfig.toml`, or development-only modules by the standalone binary.

## Documentation changes

Update `apps/cli/README.md` and any public installation documentation with:

- npm installation on Ubuntu, macOS, and Windows,
- standalone archive installation for each initial target,
- the difference between the Node-required npm build and self-contained executable,
- supported OS/architecture table,
- where non-secret issuer preferences are stored,
- which platform credential store protects sessions,
- Linux desktop/headless secure-store requirements and actionable failure behavior,
- checksum verification examples,
- unsigned-binary warning for this phase,
- upgrade instructions for npm and manual archive installations.

Keep examples native to each shell where syntax differs. Do not present POSIX `export`, path, or line-continuation syntax as working PowerShell syntax.

## Implementation order

1. Introduce platform-neutral browser and issuer-preference abstractions with unit tests.
2. Implement and test Windows/Linux behavior while preserving macOS preference compatibility.
3. Remove npm OS restrictions and update package verification.
4. Add native CLI source and packed npm matrices; make them green before adding binaries.
5. Add the pinned Bun build script and narrow Ink optional-peer plugin.
6. Add native standalone matrix and secure-store/system-CA smoke coverage.
7. Add reusable black-box tests shared by npm and standalone artifacts.
8. Add GitHub Release archive/checksum publication tied to the exact Changesets release tag.
9. Update user documentation and release notes.
10. Run the repository's normal validation and the new matrix; inspect git status for generated binary debris.

Keep changes reviewable. Platform support, CI, Bun packaging, and release upload may be separate pull requests, but npm metadata must not claim Windows support before its required CI and runtime behavior land.

## Acceptance criteria

### Functionality

- A clean supported Windows installation can install the npm package, run `weldall --version`, configure an issuer, log in, make an authenticated request, and log out.
- Equivalent user flows work on supported Ubuntu and macOS installations.
- Refresh tokens and DPoP key material are stored only through the platform credential store and are removed on logout.
- Browser launch and loopback callbacks work without shell interpolation or quoting vulnerabilities.
- Existing macOS `defaults`/MDM issuer behavior remains compatible.
- IaC, upload/download, JSON, and human-readable commands behave consistently across platforms.

### npm artifact

- `npm install --global @weldall/cli` works on Ubuntu, macOS, and Windows with Node.js 22.15 or newer.
- The actual packed tarball passes installation and command smoke tests on every native runner.
- Windows PowerShell and `cmd.exe` shims correctly preserve `--use-system-ca` and user arguments.
- Installing without optional dependencies still permits help and IaC startup, while session commands fail closed and clearly.

### standalone artifact

- Every initial target is built and executed on a matching native runner.
- The copied executable starts without Node.js, npm, Bun, `node_modules`, the repository, or its build working directory.
- Embedded Ink rendering and the target keyring addon load successfully.
- The executable uses system CAs and does not autoload local development configuration.
- Binary `--version` exactly matches `apps/cli/package.json` and the GitHub release.

### CI and release

- The complete CLI-specific source suite passes on Ubuntu, Windows, macOS ARM64, and macOS Intel.
- Packed npm and standalone black-box suites pass on their full native matrices.
- Existing Linux monorepo and Playwright E2E remain green.
- Changesets npm publication is gated by the cross-platform jobs.
- Every CLI GitHub release receives the four named archives and a matching `SHA256SUMS` file.
- CI and local packaging leave no hidden `.bun-build`, binary, archive, or temporary artifacts in the repository.

## Deferred follow-up

After this plan lands, create a separate distribution-hardening task for:

- Windows Authenticode signing and timestamping,
- Apple Developer ID signing, hardened runtime, notarization, and stapling where applicable,
- WinGet portable or MSIX publication,
- Homebrew formula/tap publication,
- Windows ARM64 and Linux ARM64/musl targets,
- SBOM/provenance/attestation improvements beyond checksums and third-party notices,
- enterprise Windows registry/Group Policy issuer policy if customers require it.

## Research references

- Bun standalone executable and target documentation: <https://bun.sh/docs/bundler/executables>
- Bun/Ink optional peer issue: <https://github.com/vadimdemedes/ink/issues/886>
- Bun Ink/Yoga executable issue history: <https://github.com/oven-sh/bun/issues/13552>
- Bun native-addon executable behavior: <https://github.com/oven-sh/bun/issues/15374>
- Bun system-CA implementation: <https://github.com/oven-sh/bun/pull/22441>
- npm Windows shim implementation: <https://github.com/npm/cmd-shim>
- Cross-platform keyring binding: <https://github.com/Brooooooklyn/keyring-node>
- Example platform-binary distribution architecture (Cline): <https://github.com/cline/cline/blob/HEAD/sdk/apps/cli/DISTRIBUTION.md>
- Example native build/release architecture (Clerk): <https://github.com/clerk/cli/blob/main/docs/releasing.md>
- Windows package/signing guidance for the deferred phase: <https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation>
- Apple notarization guidance for the deferred phase: <https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>
