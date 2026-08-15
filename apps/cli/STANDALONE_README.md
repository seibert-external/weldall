# Weldall standalone CLI

## Experimental standalone binaries

Standalone binaries require no Node.js, npm, or Bun. They are currently unsigned. Download the appropriate asset from [GitHub Releases](https://github.com/seibert-external/weldall/releases).

After downloading the trusted binary:

```sh
# macOS
xattr -d com.apple.quarantine ./weldall
chmod +x ./weldall

# Linux
chmod +x ./weldall
```

Windows PowerShell:

```powershell
Unblock-File .\weldall.exe
```

Run `./weldall --help` or `weldall.exe --help` for usage.
