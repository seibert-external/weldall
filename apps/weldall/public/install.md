# Install the Weldall CLI

Install the Weldall CLI on this machine for the current user.

## Choose a distribution

- **npm package:** supports Ubuntu, macOS, and Windows and requires Node.js 22.15.0 or newer plus npm.
- **Standalone executable:** requires no Node.js, npm, or Bun. Download it from the scoped [`@weldall/cli` GitHub Release](https://github.com/seibert-external/weldall/releases). Standalone files are currently unsigned; verify the archive against the release's `SHA256SUMS` before extracting or running it, and expect possible Gatekeeper or SmartScreen warnings.

Do not replace a working Node.js installation that already meets the version requirement. Ask before using `sudo` or making another system-wide change that requires elevation.

## Inspect the machine

Use the branch that matches the shell. Do not run POSIX commands in PowerShell.

### POSIX shell (Linux or macOS)

```sh
uname -s
node --version
npm --version
command -v weldall
weldall --version
npm view @weldall/cli version
```

A missing-command error is expected when Node.js, npm, or Weldall is not installed.

### PowerShell (Windows)

```powershell
[System.Environment]::OSVersion
node --version
npm --version
Get-Command weldall -ErrorAction SilentlyContinue
weldall --version
npm view @weldall/cli version
```

A command-not-found error is expected when Node.js, npm, or Weldall is not installed.

## Install or update the npm package

If Node.js or npm is missing, or Node.js is older than 22.15.0, install a current Node.js release with npm using a trusted package manager already available on the machine. Prefer an existing version manager such as `mise`, `asdf`, `nvm`, or `volta`. Homebrew is suitable on macOS:

```sh
brew install node
```

On Linux, use the system package manager only if it supplies Node.js 22.15.0 or newer. On Windows, use an existing package manager or version manager. Otherwise follow the official instructions at <https://nodejs.org/en/download>.

Confirm the runtime, then install or update without bypassing npm's protections.

### POSIX shell

```sh
node --version
npm --version
npm install --global @weldall/cli@latest
hash -r
weldall --version
```

### PowerShell

```powershell
node --version
npm --version
npm install --global @weldall/cli@latest
weldall --version
```

If the installed version was already current, leave it in place and report that no update was needed.

## Install or update the standalone executable

Standalone release assets are unsigned. Download them only from the scoped GitHub Release, verify SHA-256 **before extraction or execution**, and expect macOS Gatekeeper or Windows SmartScreen to warn on first launch. The [CLI README](https://github.com/seibert-external/weldall/tree/main/apps/cli#install-or-upgrade-a-standalone-executable) has additional platform details.

### POSIX shell (Linux x64 or macOS)

Set `VERSION` to the release version and `TARGET` to `linux-x64`, `darwin-arm64`, or `darwin-x64`:

```sh
VERSION=1.2.3
TARGET=darwin-arm64
TAG="%40weldall%2Fcli%40${VERSION}"
BASE="https://github.com/seibert-external/weldall/releases/download/${TAG}"
ARCHIVE="weldall-v${VERSION}-${TARGET}.tar.gz"
WORK="$(mktemp -d)"
cd "$WORK"
curl --fail --location --remote-name "$BASE/$ARCHIVE"
curl --fail --location --remote-name "$BASE/SHA256SUMS"
EXPECTED="$(awk -v file="$ARCHIVE" '$2 == file { print $1 }' SHA256SUMS)"
if command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
else
  ACTUAL="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
fi
test -n "$EXPECTED" && test "$ACTUAL" = "$EXPECTED"
tar -xzf "$ARCHIVE"
mkdir -p "$HOME/.local/bin"
install -m 0755 weldall "$HOME/.local/bin/weldall"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.profile" ;; esac
export PATH="$HOME/.local/bin:$PATH"
weldall --version
```

The `install` command replaces the user copy on upgrade; repeat the verified download with the new version. Open a new login shell to pick up the persisted `~/.profile` PATH entry.

### PowerShell (Windows x64)

```powershell
$Version = "1.2.3"
$Archive = "weldall-v$Version-windows-x64.zip"
$Tag = [uri]::EscapeDataString("@weldall/cli@$Version")
$Base = "https://github.com/seibert-external/weldall/releases/download/$Tag"
$Work = Join-Path ([IO.Path]::GetTempPath()) "weldall-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force $Work | Out-Null
Set-Location $Work
Invoke-WebRequest "$Base/$Archive" -OutFile $Archive
Invoke-WebRequest "$Base/SHA256SUMS" -OutFile SHA256SUMS
$Expected = ((Select-String -Path SHA256SUMS -Pattern "^[0-9a-f]{64}  $([regex]::Escape($Archive))$").Line -split "  ")[0]
$Actual = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
if (-not $Expected -or $Actual -ne $Expected) { throw "SHA-256 mismatch for $Archive" }
Expand-Archive -LiteralPath $Archive -DestinationPath .\release -Force
$Bin = Join-Path $HOME "bin"
New-Item -ItemType Directory -Force $Bin | Out-Null
Copy-Item .\release\weldall.exe (Join-Path $Bin "weldall.exe") -Force
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($UserPath -split ";") -notcontains $Bin) {
  [Environment]::SetEnvironmentVariable("Path", "$Bin;$UserPath", "User")
}
$env:Path = "$Bin;$env:Path"
weldall --version
```

Repeat the verified download and `Copy-Item -Force` to replace the executable on upgrade. Open a new PowerShell session to use the persisted user PATH.

## Configure the Weldall issuer

### POSIX shell

```sh
weldall config set-issuer https://weldall.mse.coolify-dev.seibert.tools
weldall config get-issuer
```

### PowerShell

```powershell
weldall config set-issuer https://weldall.mse.coolify-dev.seibert.tools
weldall config get-issuer
```

Confirm that the reported issuer is exactly `https://weldall.mse.coolify-dev.seibert.tools`. If installation or configuration fails, report the failing command and its output, then stop instead of claiming success.

The non-secret issuer is saved in `~/.weldall/config.json` on Linux, `%USERPROFILE%\.weldall\config.json` on Windows, or the preserved `dev.seibert.weldall-cli/Issuer` Preferences key on macOS. Sessions use Linux Secret Service/keyutils, Windows Credential Manager, or macOS Keychain. If Linux has no usable secure-store backend, report the actionable error and do not create a plaintext fallback.

## Optional login

After installation and issuer verification, ask whether the user wants to log in. Explain that `weldall login` opens the platform browser and that they should approve only if they requested the login on this device. Do not start login until the user explicitly agrees.

If they agree, run:

```sh
weldall login
```

Report whether login completed. On failure, report the error and a useful next step instead of retrying blindly.
