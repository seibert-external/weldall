import { describe, expect, it } from "vitest";
import { WELDALL_ISSUER } from "../src/server/oauth/constants";
import { testResultUrl } from "../src/server/auth/login-test-result-url";

const testId = "00000000-0000-4000-8000-000000000001";
const params = (url: string) => {
  const parsed = new URL(url);
  expect(`${parsed.origin}${parsed.pathname}`).toBe(`${WELDALL_ISSUER}/login/test-result`);
  return Object.fromEntries(parsed.searchParams);
};

describe("login test result URL", () => {
  it("reports a pass without a reason, whatever code is given", () => {
    expect(params(testResultUrl("setup-test", testId, true))).toEqual({
      mode: "setup-test",
      testId,
      passed: "true",
    });
    expect(params(testResultUrl("setup-test", testId, true, "entra_guest_denied"))).toEqual({
      mode: "setup-test",
      testId,
      passed: "true",
    });
  });

  it.each(["entra_email_unverified", "entra_guest_denied", "entra_claims_missing"])(
    "forwards the allowlisted failure reason %s",
    (code) => {
      expect(params(testResultUrl("provider-test", testId, false, code))).toEqual({
        mode: "provider-test",
        testId,
        passed: "false",
        reason: code,
      });
    },
  );

  it.each([undefined, "setup_email_mismatch", "unverified_identity", "login_unavailable"])(
    "keeps any other failure (%s) without a reason",
    (code) => {
      expect(params(testResultUrl("provider-test", testId, false, code))).toEqual({
        mode: "provider-test",
        testId,
        passed: "false",
      });
    },
  );
});
