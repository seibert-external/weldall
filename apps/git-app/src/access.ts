import { LOGIN_SCOPE } from "@weldall/sdk";
import { GitAppError } from "./errors.js";
import { weldallCode, weldallFailure, type AppHostApi } from "./weldall.js";

/**
 * Asks Weldall whether the person still holds the login permission and `scopes` right now. The
 * access token was checked when it was issued; this catches a permission removed since. Fails
 * closed: when Weldall cannot answer, the request is refused with 503.
 */
export async function authorizePerson(
  weldall: AppHostApi,
  subject: string,
  scopes: readonly string[],
): Promise<void> {
  const requested = [...new Set([LOGIN_SCOPE, ...scopes])];
  let answer;
  try {
    answer = await weldall.checkSubjectScopes(subject, requested);
  } catch (error) {
    // The real check-scopes endpoint answers `404 not_found` for an unknown or unverified user;
    // `unknown_subject` is the app host API's code for the same case.
    const code = weldallCode(error);
    if (code === "not_found" || code === "unknown_subject")
      throw new GitAppError("access_denied", "Weldall does not know your account.", 403);
    throw weldallFailure(error, "check your permissions");
  }
  const missing = requested.filter(
    (scope) => answer.missing.includes(scope) || !answer.granted.includes(scope),
  );
  if (missing.includes(LOGIN_SCOPE))
    throw new GitAppError("access_denied", "You may no longer use Weldall.", 403);
  if (missing.length)
    throw new GitAppError(
      "access_denied",
      `You lack the permission ${missing.join(", ")} for this Git app. Ask a Weldall administrator to assign it.`,
      403,
    );
}
