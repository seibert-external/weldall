import { db, IAC_SCOPE_KEY } from "@weldall/db";
import { MACHINE_TOKEN_TYP, verifyStrictDpop, type ReplayStore } from "@weldall/sdk";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from "jose";
import { WELDALL_ISSUER, WELDALL_RESOURCE } from "../oauth/constants";
import { getWeldallSigningKey } from "../oauth/jwt";
import { auditRequestIdentifiers } from "../audit/service";
import { postgresReplayStore } from "../oauth/replay";
import type { IacActor } from "./service";

export function canonicalIacRequestUrl(request: Request): string {
  return `${WELDALL_ISSUER}${new URL(request.url).pathname}`;
}

export async function requireIacMachine(
  request: Request,
  store: ReplayStore = postgresReplayStore,
  identifiers: ReturnType<typeof auditRequestIdentifiers> = auditRequestIdentifiers(request),
): Promise<IacActor> {
  const authorization = request.headers.get("authorization");
  const proof = request.headers.get("dpop");
  if (!authorization?.startsWith("DPoP ") || !proof || proof.includes(","))
    throw new Response("Machine DPoP authorization required", { status: 401 });
  const token = authorization.slice(5);
  let claims: JWTPayload | undefined;
  try {
    claims = await verifyWeldallMachineToken(token);
  } catch {
    throw new Response("Invalid machine token", { status: 401 });
  }
  if (
    !claims ||
    claims.identity_type !== "machine" ||
    claims.aud !== WELDALL_RESOURCE ||
    typeof claims.client_id !== "string" ||
    !(typeof claims.scope === "string" && claims.scope.split(" ").includes(IAC_SCOPE_KEY)) ||
    typeof claims.cnf !== "object" ||
    !claims.cnf ||
    !("jkt" in claims.cnf) ||
    typeof claims.cnf.jkt !== "string"
  )
    throw new Response("Invalid IaC machine token", { status: 401 });
  const keyThumbprint = (claims.cnf as { jkt: string }).jkt;
  await verifyStrictDpop(proof, {
    method: request.method,
    url: canonicalIacRequestUrl(request),
    replay: store,
    expectedJkt: keyThumbprint,
    accessToken: token,
  });
  const machine = await db.machineClient.findUnique({
    where: { clientId: claims.client_id },
    include: { keys: true, allowedScopes: { include: { scope: true } } },
  });
  const key = machine?.keys.find((item) => item.thumbprint === keyThumbprint && !item.revokedAt);
  if (
    !machine?.enabled ||
    machine.deactivatedAt ||
    !key ||
    !machine.allowedScopes.some(({ scope }) => scope.key === IAC_SCOPE_KEY)
  )
    throw new Response("IaC machine authorization is no longer active", { status: 401 });
  return {
    clientId: machine.clientId,
    keyId: key.kid,
    keyThumbprint: key.thumbprint,
    ...identifiers,
  };
}

/** Verify the exact environment-backed key used by signWeldallJwt. */
export async function verifyWeldallMachineToken(token: string): Promise<JWTPayload> {
  const header = decodeProtectedHeader(token);
  const signingKey = await getWeldallSigningKey();
  if (
    header.typ !== MACHINE_TOKEN_TYP ||
    header.alg !== "ES256" ||
    typeof header.kid !== "string" ||
    header.kid !== signingKey.kid
  )
    throw new Error("Invalid Weldall machine token header");
  const { payload } = await jwtVerify(token, await importJWK(signingKey.publicJwk, "ES256"), {
    issuer: WELDALL_ISSUER,
    audience: WELDALL_RESOURCE,
    algorithms: ["ES256"],
    requiredClaims: ["iss", "sub", "aud", "iat", "exp", "jti"],
    maxTokenAge: "5m",
  });
  return payload;
}
