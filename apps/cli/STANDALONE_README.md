# Weldall experimental standalone CLI

For most users, install the recommended npm package:

```sh
npm install --global @weldall/cli@latest
```

## Experimental standalone binaries

Standalone binaries require no Node.js, npm, or Bun. The macOS binaries are signed with a Seibert Developer ID certificate and notarized by Apple. Linux and Windows binaries are unsigned.

Download the appropriate asset from [GitHub Releases](https://github.com/seibert-external/weldall/releases), then make it executable on macOS or Linux:

```sh
chmod +x ./weldall
```

On macOS, the signature also protects the saved session in Keychain. After switching from npm or an unsigned build, run `weldall login` again.

On Windows PowerShell, unblock the downloaded binary:

```powershell
Unblock-File .\weldall.exe
```
