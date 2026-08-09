import { WELDALL_CLIENT_ID, WELDALL_ISSUER } from "../oauth/constants";
import { LOGIN_SCOPE_REQUIRED_DESCRIPTION, hasLoginScopeForUserId } from "./login-policy";

const authorizePath = "/api/auth/oauth2/authorize";
const consentPath = "/api/auth/oauth2/consent";

export function enforceCliConsent(request: Request): Request {
  if (request.method !== "GET") return request;
  const url = new URL(request.url);
  if (
    url.pathname.replace(/\/+$/, "") !== authorizePath ||
    url.searchParams.get("client_id") !== WELDALL_CLIENT_ID
  ) {
    return request;
  }
  url.searchParams.set("prompt", "consent");
  return new Request(url, request);
}

async function acceptedConsentQuery(request: Request): Promise<URLSearchParams | null> {
  if (request.method !== "POST") return null;
  const url = new URL(request.url);
  if (url.pathname.replace(/\/+$/, "") !== consentPath) return null;
  const body = (await request
    .clone()
    .json()
    .catch(() => null)) as { accept?: unknown; oauth_query?: unknown } | null;
  if (body?.accept !== true || typeof body.oauth_query !== "string") return null;
  const query = new URLSearchParams(body.oauth_query);
  return query.get("client_id") === WELDALL_CLIENT_ID ? query : null;
}

function oauthErrorUrl(query: URLSearchParams): string | null {
  const redirectUri = query.get("redirect_uri");
  if (!redirectUri) return null;
  let callback: URL;
  try {
    callback = new URL(redirectUri);
  } catch {
    return null;
  }
  if (
    callback.protocol !== "http:" ||
    callback.hostname !== "127.0.0.1" ||
    callback.pathname !== "/callback"
  ) {
    return null;
  }
  callback.searchParams.set("error", "access_denied");
  callback.searchParams.set("error_description", LOGIN_SCOPE_REQUIRED_DESCRIPTION);
  callback.searchParams.set("iss", WELDALL_ISSUER);
  const state = query.get("state");
  if (state) callback.searchParams.set("state", state);
  return callback.toString();
}

export async function denyCliConsentWithoutLoginScope(
  request: Request,
  session: { user?: { id?: unknown } } | null,
): Promise<Response | null> {
  const query = await acceptedConsentQuery(request);
  if (!query) return null;
  const userId = session?.user?.id;
  if (typeof userId === "string" && (await hasLoginScopeForUserId(userId))) return null;
  const url = oauthErrorUrl(query);
  return url ? Response.json({ redirect: true, url }) : null;
}
