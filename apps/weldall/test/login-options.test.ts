import { describe, expect, it } from "vitest";
import { loginErrorMessage } from "../src/app/login/login-options";

const generic = "Login failed. Please retry or contact your administrator.";

describe("login error message", () => {
  it("explains an Entra ID account without a verified email", () => {
    expect(loginErrorMessage("entra_email_unverified")).toBe(
      "Microsoft Entra ID did not confirm a verified email address for your account. Ask your administrator to check the optional claims of the Weldall app registration and the email address of your account.",
    );
  });

  it("explains that Entra ID guest accounts are denied", () => {
    expect(loginErrorMessage("entra_guest_denied")).toBe(
      "Guest accounts cannot sign in. Sign in with a member account of your organization.",
    );
  });

  it("explains a missing Entra ID acct claim", () => {
    expect(loginErrorMessage("entra_claims_missing")).toBe(
      "Microsoft Entra ID did not send the acct claim Weldall needs. Ask your administrator to add the optional claim acct to the Weldall app registration.",
    );
  });

  it.each([
    "unverified_identity",
    "email_domain_denied",
    "session_unavailable",
    "",
    null,
    "toString",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "ENTRA_GUEST_DENIED",
    " entra_guest_denied",
  ])("keeps the generic message for %j", (code) => {
    expect(loginErrorMessage(code)).toBe(generic);
  });
});
