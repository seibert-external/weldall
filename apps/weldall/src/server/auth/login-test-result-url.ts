import { explainedLoginError } from "../../lib/login-error-messages";
import { WELDALL_ISSUER } from "../oauth/constants";

/** A failed test names its reason only for the allowlisted explained login error codes. */
export function testResultUrl(
  mode: "setup-test" | "provider-test",
  testId: string,
  passed: boolean,
  code?: string,
): string {
  const url = new URL("/login/test-result", WELDALL_ISSUER);
  url.searchParams.set("mode", mode);
  url.searchParams.set("testId", testId);
  url.searchParams.set("passed", String(passed));
  const reason = passed ? undefined : explainedLoginError(code);
  if (reason) url.searchParams.set("reason", reason);
  return url.toString();
}
