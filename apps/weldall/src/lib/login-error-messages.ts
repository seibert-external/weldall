import { z } from "zod";

export const GENERIC_LOGIN_ERROR = "Login failed. Please retry or contact your administrator.";

// Only the codes of the Entra ID trust rules get a specific message. Every other code, including
// unknown or hostile query input, stays generic on purpose so failures reveal nothing else.
const explainedLoginErrors = {
  entra_email_unverified:
    "Microsoft Entra ID did not confirm a verified email address for your account. Ask your administrator to check the optional claims of the Weldall app registration and the email address of your account.",
  entra_claims_missing:
    "Microsoft Entra ID did not send the acct claim Weldall needs. Ask your administrator to add the optional claim acct to the Weldall app registration.",
  entra_guest_denied:
    "Guest accounts cannot sign in. Sign in with a member account of your organization.",
} as const;
export type ExplainedLoginError = keyof typeof explainedLoginErrors;
export const explainedLoginErrorSchema = z.enum(
  Object.keys(explainedLoginErrors) as [ExplainedLoginError, ...ExplainedLoginError[]],
);

/** The code if it is one of the allowlisted explained codes, else undefined (also for arrays). */
export function explainedLoginError(code: unknown): ExplainedLoginError | undefined {
  const result = explainedLoginErrorSchema.safeParse(code);
  return result.success ? result.data : undefined;
}

export function loginErrorMessage(code: string | null): string {
  const explained = explainedLoginError(code);
  return explained ? explainedLoginErrors[explained] : GENERIC_LOGIN_ERROR;
}
