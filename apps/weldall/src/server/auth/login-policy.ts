import { APIError } from "better-auth/api";
import { db, LOGIN_SCOPE_KEY } from "@weldall/db";

export async function hasLoginScopeForEmail(email: string): Promise<boolean> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return false;
  return Boolean(
    await db.emailScopeGrant.findFirst({
      where: {
        assignment: { normalizedEmail },
        scope: { key: LOGIN_SCOPE_KEY, isSystem: true },
      },
      select: { id: true },
    }),
  );
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
    error_description: "the weldall:login scope must be assigned to your account",
  });
}
