import { getWeldallSigningKey } from "@/server/oauth/jwt";

export async function GET() {
  const key = await getWeldallSigningKey();
  return Response.json(
    { keys: [{ ...key.publicJwk, alg: "ES256", use: "sig", kid: key.kid }] },
    { headers: { "cache-control": "public, max-age=60" } },
  );
}
