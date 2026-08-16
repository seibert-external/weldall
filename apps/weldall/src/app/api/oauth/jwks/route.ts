import { getWeldallSigningKey } from "@/server/oauth/jwt";
import { withRequestLogging } from "@/server/observability/http";

async function get() {
  const key = await getWeldallSigningKey();
  return Response.json(
    { keys: [{ ...key.publicJwk, alg: "ES256", use: "sig", kid: key.kid }] },
    { headers: { "cache-control": "public, max-age=60" } },
  );
}

export const GET = withRequestLogging("/api/oauth/jwks", get, { successLevel: "debug" });
