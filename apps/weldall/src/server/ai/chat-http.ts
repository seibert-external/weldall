import { auth } from "@/server/auth/auth";
import { isTrustedBrowserRequest } from "@/server/auth/browser-request";

export type AuthenticatedChatUser = {
  id: string;
  email: string;
  name: string;
};

export async function authenticateChatRequest(
  request: Request,
): Promise<{ ok: true; user: AuthenticatedChatUser } | { ok: false; response: Response }> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.id || !session.user.email || !session.user.emailVerified) {
    return {
      ok: false,
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (!isTrustedBrowserRequest(request)) {
    return {
      ok: false,
      response: Response.json({ error: "Invalid request origin." }, { status: 403 }),
    };
  }

  return {
    ok: true,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name ?? "",
    },
  };
}

export const privateJsonHeaders = { "cache-control": "private, no-store" };
