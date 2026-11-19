import { GitAppError } from "../errors.js";
import type { GitHostCheckState } from "./git-host.js";

/** The result of one set-up check, before the checklist adds its id and title. */
export type Outcome = { state: GitHostCheckState; reason: string; action: string | null };
export const pass = (reason: string): Outcome => ({ state: "pass", reason, action: null });
export const fail = (reason: string, action: string): Outcome => ({
  state: "fail",
  reason,
  action,
});
export const unverifiable = (reason: string, action: string | null): Outcome => ({
  state: "unverifiable",
  reason,
  action,
});

export const RETRY = "Run the check again later.";

const CREDENTIAL_CODES = [
  "credential_unavailable",
  "credential_ambiguous",
  "grant_mismatch",
  "credential_rejected",
];

/**
 * The "cannot verify" outcomes of one host's checklist. Texts are fixed: host response text is
 * never used; only Weldall's own error codes are named.
 */
export function cannotVerifyOutcomes<Response extends { status: number }>({
  host,
  credential,
  credentialCheck,
  rateLimitedReason,
  byCode = {},
  isRateLimited = () => false,
}: {
  /** The host's name in texts, e.g. "GitHub". */
  host: string;
  /** What a dependent check needs, e.g. "a working App credential". */
  credential: string;
  /** The check that verifies the credential, quoted, e.g. "“App authentication”". */
  credentialCheck: string;
  rateLimitedReason: string;
  /** Outcomes for host-specific error codes. */
  byCode?: Record<string, Outcome>;
  isRateLimited?: (response: Response) => boolean;
}) {
  /** Turns an error of a dependent step into "cannot verify" with a fixed text. */
  function cannotVerify(error: unknown): Outcome {
    if (error instanceof GitAppError) {
      if (CREDENTIAL_CODES.includes(error.code))
        return unverifiable(
          `Needs ${credential} (see ${credentialCheck}).`,
          `Fix ${credentialCheck} first.`,
        );
      const special = Object.hasOwn(byCode, error.code) ? byCode[error.code] : undefined;
      if (special) return special;
      if (error.code === "upstream_rate_limited") return unverifiable(rateLimitedReason, RETRY);
      const code = /^[a-z_]{1,64}$/.test(error.code) ? error.code : "error";
      return unverifiable(`${host} could not be asked (${code}).`, RETRY);
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
      return unverifiable(`${host} did not answer in time.`, RETRY);
    return unverifiable(`${host} could not be reached.`, RETRY);
  }

  /** Maps a status the caller does not handle itself to "cannot verify". */
  function unexpectedStatus(response: Response): Outcome {
    if (isRateLimited(response)) return unverifiable(rateLimitedReason, RETRY);
    return unverifiable(`${host} answered with HTTP ${response.status}.`, RETRY);
  }

  return { cannotVerify, unexpectedStatus };
}
