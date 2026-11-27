/**
 * Stands in for `weldall` on PATH in the real-git tests: git runs `weldall git-credential <op>`,
 * and this runs the real protocol code and the real access checks (`gitCredentialAccess`: the
 * URL must lie below the git route of a registry Weldall lists in `GET /api/me/apps`) over
 * `testOpenRegistry` instead of the DPoP login, which is exactly the seam the sandbox door will
 * replace.
 *
 * Environment: `WELDALL_TEST_ISSUER` (Weldall's origin), `WELDALL_TEST_REGISTRY` (URL of the
 * resource registry as JSON), `WELDALL_TEST_APPS` (URL of Weldall's app list with its
 * registries), `WELDALL_TEST_REGISTRY_APIS` (JSON map of registry origin to the plain-HTTP base of
 * its stand-in).
 */
import { runGitCredentialHelper } from "../../src/git/credential-helper.js";
import { gitCredentialAccess } from "../../src/git/weldall-access.js";
import { testOpenRegistry } from "./test-registries.js";

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
    open: testOpenRegistry({
      registry: async () => (await fetch(process.env.WELDALL_TEST_REGISTRY ?? "")).json(),
      apps: async () => {
        const response = await fetch(process.env.WELDALL_TEST_APPS ?? "");
        return response.status === 404 ? null : response.json();
      },
      apis: () =>
        JSON.parse(process.env.WELDALL_TEST_REGISTRY_APIS ?? "{}") as Record<string, string>,
    }),
  }),
});
