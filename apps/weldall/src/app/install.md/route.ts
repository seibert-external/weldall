import { WELDALL_ISSUER } from "@/server/oauth/constants";

const installGuide = (origin: string) => `# Install the Weldall CLI

## npm (recommended)

The npm package supports Ubuntu, Windows 10 version 1809 or newer, Windows Server 2019 or newer, and current macOS releases. It requires Node.js 22.15 or newer.

\`\`\`sh
npm install --global @weldall/cli@latest
weldall --version
weldall config set-issuer ${origin}
weldall login
\`\`\`

## Experimental standalone binaries

Standalone binaries require no Node.js, npm, or Bun. Initial targets are Linux x64, Windows x64, and macOS ARM64/x64. They are currently unsigned. Download the appropriate asset from [GitHub Releases](https://github.com/seibert-external/weldall/releases).

After downloading the trusted binary:

\`\`\`sh
# macOS
xattr -d com.apple.quarantine ./weldall
chmod +x ./weldall

# Linux
chmod +x ./weldall
\`\`\`

Windows PowerShell:

\`\`\`powershell
Unblock-File .\\weldall.exe
\`\`\`
`;

export function GET() {
  return new Response(installGuide(WELDALL_ISSUER), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
