import { z } from "zod";
import { readBoundedBody } from "../../core/transport";
import { ConnectorError, ProviderTokenError, RejectedProviderCredentials } from "../../errors";
import { canonicalScopes, cloudIdSchema } from "./config";

export const credentialsSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number().finite(),
    grantedScopes: z.array(z.string()),
  })
  .strict();
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive().max(86400),
  token_type: z.string(),
  scope: z.string().min(1).optional(),
});
export const resourceSchema = z.object({
  id: cloudIdSchema,
  name: z.string().max(500),
  url: z.string().url(),
  scopes: z.array(z.string()).max(200),
});
export type Resource = z.infer<typeof resourceSchema>;

async function readJson(response: Response, signal: AbortSignal) {
  return JSON.parse(
    Buffer.from(await readBoundedBody({ response, maximum: 256_000, signal })).toString("utf8"),
  ) as unknown;
}
function transientTokenFailure(value: unknown, status: number) {
  return (
    status === 429 ||
    status >= 500 ||
    z.object({ error: z.enum(["temporarily_unavailable", "server_error"]) }).safeParse(value)
      .success
  );
}
/** All credential-bearing requests use fixed reviewed endpoints and reject redirects. */
export async function getAtlassianJson(
  path: "/me" | "/oauth/token/accessible-resources",
  accessToken: string,
) {
  const signal = AbortSignal.timeout(10_000);
  const response = await fetch(`https://api.atlassian.com${path}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ConnectorError(
      response.status === 401 || response.status === 403
        ? "grant_mismatch"
        : "provider_unavailable",
      "Could not verify Atlassian access.",
      502,
    );
  }
  return readJson(response, signal);
}
export async function getResources(accessToken: string) {
  return z
    .array(resourceSchema)
    .max(200)
    .parse(await getAtlassianJson("/oauth/token/accessible-resources", accessToken));
}
export async function exchangeToken(body: Record<string, string>, requestedScopes: string[]) {
  const signal = AbortSignal.timeout(10_000);
  const response = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal,
  });
  let value: unknown;
  try {
    value = await readJson(response, signal);
  } catch {
    if (!response.ok && (response.status === 429 || response.status >= 500))
      throw new ProviderTokenError({ authorizationLost: false, retryable: true });
    throw new ProviderTokenError({ authorizationLost: false });
  }
  if (!response.ok)
    throw new ProviderTokenError({
      authorizationLost: z.object({ error: z.literal("invalid_grant") }).safeParse(value).success,
      retryable: transientTokenFailure(value, response.status),
    });
  const parsed = tokenSchema.safeParse(value);
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
    // A successful exchange may already have issued/rotated credentials. Never retry blindly.
    const cleanup = z
      .object({ access_token: z.string().min(1), refresh_token: z.string().optional() })
      .safeParse(value);
    if (cleanup.success) throw new RejectedProviderCredentials({ credentials: cleanup.data });
    throw new ProviderTokenError({ authorizationLost: false });
  }
  return credentialsSchema.parse({
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: Date.now() + parsed.data.expires_in * 1000,
    // OAuth may omit scope when unchanged; site/product consent is independently checked below.
    grantedScopes:
      parsed.data.scope === undefined
        ? canonicalScopes(requestedScopes)
        : canonicalScopes(parsed.data.scope.split(" ").filter(Boolean)),
  });
}
