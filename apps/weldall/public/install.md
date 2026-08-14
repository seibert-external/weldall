# Install the Weldall CLI

Install the Weldall CLI on this machine so it can be used by the current user.

## Requirements

- The Weldall package supports macOS and Linux. The interactive configuration and login steps below require macOS.
- Node.js 22.15.0 or newer and npm are required.
- Do not replace a working Node.js installation that already meets the version requirement.
- Ask before using `sudo` or making another system-wide change that requires elevated privileges.

## Installation

1. Check the operating system and the existing runtime:

   ```sh
   uname -s
   node --version
   npm --version
   ```

2. If Node.js or npm is missing, or Node.js is older than 22.15.0, install a current Node.js release with npm using a trusted package manager already available on the machine. Prefer an existing Node.js version manager such as `mise`, `asdf`, `nvm`, or `volta`. On macOS, Homebrew is also suitable:

   ```sh
   brew install node
   ```

   On Linux, use the system's package manager only when it provides Node.js 22.15.0 or newer; otherwise follow the official installation instructions from <https://nodejs.org/en/download>.

3. Confirm that the installed runtime meets the requirement:

   ```sh
   node --version
   npm --version
   ```

4. Check whether Weldall is already installed. If it is, record the installed version and check npm for the latest published version:

   ```sh
   weldall --version
   npm view @weldall/cli version
   ```

   If Weldall is missing or a newer version is available, install or update it globally:

   ```sh
   npm install --global @weldall/cli --force
   ```

   If the installed version is already current, leave it in place and report that no update was needed.

5. Refresh the shell's command lookup if necessary and verify the installation:

   ```sh
   hash -r
   weldall --version
   ```

6. On macOS, configure this Weldall deployment as the issuer and read it back to verify the saved value:

   ```sh
   weldall config set-issuer https://weldall.mse.coolify-dev.seibert.tools
   weldall config get-issuer
   ```

   Confirm that the reported issuer is exactly `https://weldall.mse.coolify-dev.seibert.tools`. Tell the user whether installation and issuer configuration succeeded. If either command fails or the issuer does not match, report the failing command and its output, then stop instead of claiming success.

   On Linux, report that interactive issuer configuration and login are not supported; do not attempt the remaining login step.

7. After successful macOS installation and issuer verification, ask the user whether they want to log in now. Explain that `weldall login` opens a browser and that they should approve only if they requested this login on this device. Do not start login until the user explicitly agrees.

8. If the user agrees, run:

   ```sh
   weldall login
   ```

   Report whether login completed successfully. If it fails, report the error output and a useful next step instead of retrying blindly.
