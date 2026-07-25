import { randomUUID } from "node:crypto";
import type { JWK } from "jose";
import { isSha256JwkThumbprint } from "./crypto.js";
import { WeldallAuthError } from "./errors.js";
import { signEs256, verifyEs256 } from "./jwt.js";
import { parseScope } from "./scope.js";
export async function issueAccessToken(input: {
  issuer: string;
  subject: string;
  resource: string;
  clientId: string;
  scopes: string[];
  jkt: string;
  kid: string;
  privateJwk: JWK;
  now?: number;
}): Promise<string> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const scope = [...new Set(input.scopes)].sort().join(" ");
  if (!input.subject || !isSha256JwkThumbprint(input.jkt) || !parseScope(scope))
    throw new Error("invalid access-token issuance claims");
  return signEs256(
    {
      iss: input.issuer,
      sub: input.subject,
      aud: input.resource,
      client_id: input.clientId,
      scope,
      cnf: { jkt: input.jkt },
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
    },
    { ...input, typ: "at+jwt" },
  );
}
export async function verifyAccessToken(
  token: string,
  input: {
    issuer: string;
    resource: string;
    kid: string;
    publicJwk: JWK;
    clientId: string;
    requiredScopes?: readonly string[];
  },
) {
  const p = await verifyEs256(token, {
    ...input,
    audience: input.resource,
    typ: "at+jwt",
    maxTokenAge: "10m",
    errorCode: "invalid_token",
    errorStatus: 401,
  });
  const cnf = p.cnf;
  const granted = parseScope(p.scope);
  if (
    p.aud !== input.resource ||
    !cnf ||
    typeof cnf !== "object" ||
    Array.isArray(cnf) ||
    !isSha256JwkThumbprint((cnf as { jkt?: unknown }).jkt) ||
    typeof p.sub !== "string" ||
    !p.sub ||
    p.client_id !== input.clientId ||
    typeof p.jti !== "string" ||
    p.jti.length < 1 ||
    p.jti.length > 128 ||
    !Number.isInteger(p.iat) ||
    !Number.isInteger(p.exp) ||
    (p.exp as number) <= (p.iat as number) ||
    (p.exp as number) - (p.iat as number) > 600 ||
    !granted
  )
    throw new WeldallAuthError("invalid_token", "invalid access token claims", 401);
  if (input.requiredScopes?.some((scope) => !granted.includes(scope)))
    throw new WeldallAuthError(
      "insufficient_scope",
      "required scope is missing",
      403,
      input.requiredScopes,
    );
  return p as typeof p & { cnf: { jkt: string }; sub: string; scope: string };
}
