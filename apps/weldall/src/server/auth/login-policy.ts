import { APIError } from "better-auth/api";
import { db, LOGIN_SCOPE_KEY } from "@weldall/db";
import { hasEffectiveSystemScopeFor } from "../policy/resources";

export const LOGIN_SCOPE_REQUIRED_DESCRIPTION =
  "the weldall:login scope must be assigned to your account";

export async function hasLoginScopeForEmail(email: string): Promise<boolean> {
  if (!email.trim()) return false;
  return hasEffectiveSystemScopeFor(email, LOGIN_SCOPE_KEY);
}

export async function hasLoginScopeForUserId(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  return Boolean(user?.emailVerified && (await hasLoginScopeForEmail(user.email)));
}

export async function requireLoginScopeForOAuthGrant(input: {
  grantType: string;
  user?: { id?: unknown } | null;
}): Promise<Record<string, never>> {
  if (input.grantType !== "authorization_code" && input.grantType !== "refresh_token") {
    return {};
  }
  const userId = input.user?.id;
  if (typeof userId === "string" && (await hasLoginScopeForUserId(userId))) return {};
  throw new APIError("BAD_REQUEST", {
    error: "invalid_grant",
    error_description: LOGIN_SCOPE_REQUIRED_DESCRIPTION,
  });
}
