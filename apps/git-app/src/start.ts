import { createGitApp } from "./app.js";
import { GitAppConfigError, loadConfig, type GitAppConfig } from "./config.js";

type Env = Parameters<typeof loadConfig>[0];
type ReadFile = Parameters<typeof loadConfig>[1];

/**
 * Loads the configuration and builds the app. Every failure is a {@link GitAppConfigError}, whose
 * message names variables only: an error from building the app (the SDK or the host driver
 * refusing a value) is replaced by a fixed message, because its text is not ours to vouch for.
 */
export async function prepareGitApp(
  env?: Env,
  readFile?: ReadFile,
): Promise<{ config: GitAppConfig; app: ReturnType<typeof createGitApp> }> {
  const config = await loadConfig(env, readFile);
  try {
    return { config, app: createGitApp({ config }) };
  } catch {
    throw new GitAppConfigError(["The Git app could not start with this configuration."]);
  }
}

/** The start-up error text for stderr: never a value, never a stack trace. */
export function startupErrorMessage(error: unknown): string {
  return error instanceof GitAppConfigError ? error.message : "Invalid Git app configuration.";
}
