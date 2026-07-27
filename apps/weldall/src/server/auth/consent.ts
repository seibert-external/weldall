import { WELDALL_CLIENT_ID } from "../oauth/constants";

const authorizePath = "/api/auth/oauth2/authorize";

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
