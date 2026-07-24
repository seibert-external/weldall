export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    message = code,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}
export const oauthErrorResponse = (error: unknown): Response => {
  const known = error instanceof OAuthError;
  const status = known ? error.status : 400;
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    pragma: "no-cache",
  };
  if (status === 401 && known) headers["www-authenticate"] = `DPoP error="${error.code}"`;
  return Response.json(
    {
      error: known ? error.code : "invalid_request",
      error_description: known ? error.message : "request rejected",
    },
    {
      status,
      headers,
    },
  );
};
