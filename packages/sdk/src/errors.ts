export class WeldallAuthError extends Error {
  constructor(
    public readonly code: string,
    message = code,
    public readonly status = 400,
    public readonly requiredScopes: readonly string[] = [],
  ) {
    super(message);
    this.name = "WeldallAuthError";
  }
}

export const oauthErrorResponse = (error: unknown): Response => {
  const known = error instanceof WeldallAuthError;
  const status = known ? error.status : 400;
  const code = known ? error.code : "invalid_request";
  const headers = new Headers({ "cache-control": "no-store", pragma: "no-cache" });
  if (status === 401 || status === 403) {
    const scope =
      known && error.requiredScopes.length ? `, scope="${error.requiredScopes.join(" ")}"` : "";
    headers.set("www-authenticate", `DPoP error="${code}"${scope}`);
  }
  return Response.json(
    {
      error: code,
      error_description: known ? error.message : "request rejected",
    },
    { status, headers },
  );
};
