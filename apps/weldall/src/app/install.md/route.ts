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

Standalone binaries require no Node.js, npm, or Bun. Initial targets are Linux x64, Windows x64, and macOS ARM64/x64. The macOS binaries are signed with a Seibert Developer ID certificate and notarized by Apple. Linux and Windows binaries are unsigned.

Download the appropriate asset from [GitHub Releases](https://github.com/seibert-external/weldall/releases), then make it executable on macOS or Linux:

\`\`\`sh
chmod +x ./weldall
\`\`\`

On macOS, the signature also protects the saved session in Keychain. After switching from npm or an unsigned build, run \`weldall login\` again.

On Windows PowerShell, unblock the downloaded binary:

\`\`\`powershell
Unblock-File .\\weldall.exe
\`\`\`
`;

export function GET() {
  return new Response(installGuide(WELDALL_ISSUER), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
