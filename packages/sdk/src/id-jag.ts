import { randomUUID } from "node:crypto";
import type { JWK } from "jose";
import { ID_JAG_DRAFT } from "./constants.js";
import { isSha256JwkThumbprint } from "./crypto.js";
import { WeldallAuthError } from "./errors.js";
import { signEs256, verifyEs256 } from "./jwt.js";
import { parseScope } from "./scope.js";
import type { IdJagClaims } from "./types.js";
export async function issueIdJag(input: {
  issuer: string;
  subject: string;
  audience: string;
  clientId: string;
  resource: string;
  scopes: string[];
  jkt: string;
  kid: string;
  privateJwk: JWK;
  now?: number;
}): Promise<string> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const scope = [...new Set(input.scopes)].sort().join(" ");
  if (!input.subject || !isSha256JwkThumbprint(input.jkt) || !parseScope(scope))
    throw new Error("invalid ID-JAG issuance claims");
  const claims: IdJagClaims = {
    iss: input.issuer,
    sub: input.subject,
    aud: input.audience,
    client_id: input.clientId,
    resource: input.resource,
    scope,
    cnf: { jkt: input.jkt },
    jti: randomUUID(),
    iat: now,
    exp: now + 300,
    "urn:weldall:id-jag-draft": ID_JAG_DRAFT,
  };
  return signEs256(claims, { ...input, typ: "oauth-id-jag+jwt" });
}
export async function verifyIdJag(
  token: string,
  input: {
    issuer: string;
    audience: string;
    resource: string;
    clientId: string;
    kid: string;
    publicJwk: JWK;
    allowedScopes: readonly string[];
  },
): Promise<IdJagClaims> {
  const p = await verifyEs256(token, {
    ...input,
    typ: "oauth-id-jag+jwt",
    maxTokenAge: "5m",
  });
  const cnf = p.cnf;
  const scopes = parseScope(p.scope);
  if (
    p.aud !== input.audience ||
    p.resource !== input.resource ||
    p.client_id !== input.clientId ||
    typeof p.sub !== "string" ||
    !p.sub ||
    typeof p.jti !== "string" ||
    p.jti.length < 1 ||
    p.jti.length > 128 ||
    !Number.isInteger(p.iat) ||
    !Number.isInteger(p.exp) ||
    (p.exp as number) <= (p.iat as number) ||
    (p.exp as number) - (p.iat as number) > 300 ||
    !cnf ||
    typeof cnf !== "object" ||
    Array.isArray(cnf) ||
    !isSha256JwkThumbprint((cnf as { jkt?: unknown }).jkt) ||
    p["urn:weldall:id-jag-draft"] !== ID_JAG_DRAFT ||
    !scopes
  )
    throw new WeldallAuthError("invalid_grant", "invalid ID-JAG claims");
  if (scopes.some((scope) => !input.allowedScopes.includes(scope)))
    throw new WeldallAuthError("invalid_scope");
  return p as IdJagClaims;
}
