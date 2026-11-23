import { z } from "zod";

export const authorizePath = "/api/auth/oauth2/authorize";
export const consentPath = "/api/auth/oauth2/consent";
const callbackPrefix = "/api/auth/callback/";
const callbackPath = `${callbackPrefix}:providerId`;
const providerId = z.uuid();

// Only forward endpoints Weldall uses; new Better Auth plugin routes stay closed by default.
// OAuth token, revoke and userinfo have dedicated handlers outside this catch-all.
const allowlist = {
  GET: {
    "/api/auth/get-session": "The login page checks whether the browser is already signed in.",
    [authorizePath]: "The CLI opens the browser here to request an authorization code.",
    [callbackPath]: "The identity provider returns here to finish SSO, setup or a provider test.",
    "/api/auth/error": "Better Auth sends the browser here to display an authorization error.",
    "/api/auth/oidc/admin-providers": "Admins list login providers in the settings UI.",
  },
  POST: {
    "/api/auth/sign-out": "The account menu and access-denied page let users end their session.",
    [consentPath]: "The consent page submits the user's approval or denial of CLI access.",
    "/api/auth/oidc/start": "The login page starts SSO with the selected identity provider.",
    "/api/auth/oidc/setup": "The installer tests or configures the first login provider.",
    "/api/auth/oidc/admin-draft": "Admins get a callback URL before registering a new provider.",
    "/api/auth/oidc/admin-test": "Admins test a login provider's settings before saving them.",
    "/api/auth/oidc/admin-save": "Admins save new or changed login provider settings.",
  },
} satisfies Record<"GET" | "POST", Record<string, string>>;

export function allowedAuthMethod(method: string, pathname: string): "GET" | "POST" | undefined {
  if (method !== "GET" && method !== "POST") return;
  if (pathname.startsWith(callbackPrefix)) {
    if (!providerId.safeParse(pathname.slice(callbackPrefix.length)).success) return;
    pathname = callbackPath;
  }
  return Object.hasOwn(allowlist[method], pathname) ? method : undefined;
}
