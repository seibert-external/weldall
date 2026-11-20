/**
 * Stands in for `weldall` on PATH in the real-git tests: git runs `weldall git-credential <op>`,
 * and this runs the real protocol code and the real access checks (`gitCredentialAccess`: the
 * origin must be a Git app in the registry) over `testOpenGitApp` instead of the DPoP login,
 * which is exactly the seam the sandbox door will replace.
 *
 * Environment: `WELDALL_TEST_ISSUER` (Weldall's origin), `WELDALL_TEST_REGISTRY` (URL of the
 * resource registry as JSON), `WELDALL_TEST_GIT_APP_APIS` (JSON map of Git app origin to the
 * plain-HTTP base of its stand-in).
 */
import { runGitCredentialHelper } from "../../src/git/credential-helper.js";
import { gitCredentialAccess } from "../../src/git/weldall-access.js";
import { testOpenGitApp } from "./test-git-apps.js";

const [command, operation = ""] = process.argv.slice(2);
if (command !== "git-credential") {
  process.stderr.write(`unexpected weldall command: ${command}\n`);
  process.exit(2);
}

await runGitCredentialHelper({
  operation,
  input: process.stdin,
  output: process.stdout,
  errors: process.stderr,
  environment: process.env,
  weldall: gitCredentialAccess({
    issuer: async () => process.env.WELDALL_TEST_ISSUER ?? null,
    open: testOpenGitApp({
      registry: async () => (await fetch(process.env.WELDALL_TEST_REGISTRY ?? "")).json(),
      apis: () =>
        JSON.parse(process.env.WELDALL_TEST_GIT_APP_APIS ?? "{}") as Record<string, string>,
    }),
  }),
});
