/**
 * Stands in for `weldall` on PATH in the real-git test: git runs `weldall git-credential <op>`,
 * and this runs the real protocol code with a test way of reaching Weldall (a fake credential
 * endpoint instead of the DPoP login), which is exactly the seam the sandbox door will replace.
 */
import { runGitCredentialHelper } from "../../src/git/credential-helper.js";

const [command, operation = ""] = process.argv.slice(2);
if (command !== "git-credential") {
  process.stderr.write(`unexpected weldall command: ${command}\n`);
  process.exit(2);
}
const endpoint = process.env.WELDALL_TEST_CREDENTIAL_ENDPOINT ?? "";

await runGitCredentialHelper({
  operation,
  input: process.stdin,
  output: process.stdout,
  errors: process.stderr,
  environment: process.env,
  weldall: {
    issuer: async () => process.env.WELDALL_TEST_ISSUER ?? null,
    requestCredential: async (request) => {
      const response = await fetch(endpoint, { method: "POST", body: JSON.stringify(request) });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: passed through as text, like the direct access does.
      }
      return { status: response.status, body };
    },
  },
});
