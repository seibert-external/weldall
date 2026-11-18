import { WeldallAuthError, type AppHostApp, type WeldallAppHostClient } from "@weldall/sdk";
import { GitAppError } from "./errors.js";

/**
 * The part of Weldall's app host API (`createWeldallAppHostClient` in `@weldall/sdk`) the Git app
 * uses. Tests pass an in-process fake implementing the same contract.
 */
export type AppHostApi = Pick<
  WeldallAppHostClient,
  "createApp" | "updateApp" | "lookupApp" | "reportAuditEvent" | "checkSubjectScopes"
>;

/** A Weldall error code, if `error` is a rejection from Weldall. */
export const weldallCode = (error: unknown) =>
  error instanceof WeldallAuthError ? error.code : null;

/**
 * Whether a failed Weldall call may succeed when repeated: no answer at all (network), or a
 * `5xx`/`429`. A rejection by Weldall (`4xx`) is final.
 */
export function isTransientWeldallFailure(error: unknown): boolean {
  if (!(error instanceof WeldallAuthError)) return true;
  return error.status >= 500 || error.status === 429;
}

/**
 * Maps a failed Weldall call to an error for the person. Fail closed: without an answer from
 * Weldall nothing happens on the Git host. Only Weldall's error code is named, never its text.
 */
export function weldallFailure(error: unknown, what: string): GitAppError {
  if (error instanceof GitAppError) return error;
  if (error instanceof WeldallAuthError && error.status < 500 && error.status !== 429)
    return new GitAppError(
      "weldall_refused",
      `Weldall refused the Git app's request to ${what} (${/^[a-z_]{1,64}$/.test(error.code) ? error.code : "error"}). An administrator must check the Git app's machine client and resource in Weldall.`,
      503,
    );
  return new GitAppError(
    "weldall_unavailable",
    `Weldall could not be reached to ${what}. Nothing was changed on the Git host by this step; retry later.`,
    503,
  );
}

/** Looks an app up; null when Weldall knows no app of this resource with that id or repository. */
export async function lookupApp(
  weldall: AppHostApi,
  input: Parameters<AppHostApi["lookupApp"]>[0],
): Promise<{ app: AppHostApp; ownedBySubject: boolean | null } | null> {
  try {
    return await weldall.lookupApp(input);
  } catch (error) {
    if (error instanceof WeldallAuthError && error.code === "not_found") return null;
    throw weldallFailure(error, "look up the app");
  }
}
