import { readFile } from "node:fs/promises";

export const testHookMarkers = ["WELDALL_E2E_", "WELDALL_TEST_", "x-weldall-test-original-origin"];

export const requiredTestHookMarkers = [
  "WELDALL_E2E_BROWSER_URL_FILE",
  "WELDALL_E2E_CREDENTIALS_FILE",
  "WELDALL_E2E_HTTP_BRIDGE",
  "WELDALL_TEST_KEYCHAIN_GET",
  "WELDALL_TEST_KEYRING_SMOKE",
  "WELDALL_TEST_PREFERENCES_FILE",
  "WELDALL_TEST_RUNTIME_DIAGNOSTICS",
  "x-weldall-test-original-origin",
];

export async function assertNoTestHooksInArtifact(path) {
  const artifact = await readFile(path);
  const found = testHookMarkers.filter((marker) => artifact.includes(Buffer.from(marker)));
  if (found.length > 0)
    throw new Error(`Production artifact contains test hooks: ${found.join(", ")}`);
}

export async function assertTestHooksInArtifact(path) {
  const artifact = await readFile(path);
  const missing = requiredTestHookMarkers.filter(
    (marker) => !artifact.includes(Buffer.from(marker)),
  );
  if (missing.length > 0)
    throw new Error(`Test artifact is missing required hooks: ${missing.join(", ")}`);
}
