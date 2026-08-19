import { db } from "@weldall/db";
import {
  MACHINE_TOKEN_TYP,
  WeldallAuthError,
  verifyStrictDpop,
  type ReplayStore,
} from "@weldall/sdk";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from "jose";
import { auditRequestIdentifiers } from "../audit/service";
import { WELDALL_ISSUER, WELDALL_RESOURCE } from "./constants";
import { getWeldallSigningKey } from "./jwt";
import { postgresReplayStore } from "./replay";

export interface WeldallMachineActor {
  clientId: string;
  keyId: string;
  keyThumbprint: string;
  requestId: string;
  correlationId?: string;
}

export function canonicalWeldallApiRequestUrl(request: Request): string {
  return `${WELDALL_ISSUER}${new URL(request.url).pathname}`;
}

export async function authenticateWeldallMachineApiRequest(
  request: Request,
  requiredScope: string,
  store: ReplayStore = postgresReplayStore,
  identifiers: ReturnType<typeof auditRequestIdentifiers> = auditRequestIdentifiers(request),
): Promise<WeldallMachineActor> {
  const authorization = request.headers.get("authorization");
  const proof = request.headers.get("dpop");
  if (
    !authorization?.startsWith("DPoP ") ||
    authorization.includes(",") ||
    !proof ||
    proof.includes(",")
  ) {
    throw new WeldallAuthError("invalid_token", "machine DPoP authorization required", 401);
  }
  const token = authorization.slice(5);
  let claims: JWTPayload;
  try {
    claims = await verifyWeldallMachineToken(token);
  } catch {
    throw new WeldallAuthError("invalid_token", "invalid machine token", 401);
  }
  const granted = typeof claims.scope === "string" ? claims.scope.split(" ") : [];
  const keyThumbprint =
    claims.cnf &&
    typeof claims.cnf === "object" &&
    !Array.isArray(claims.cnf) &&
    "jkt" in claims.cnf &&
    typeof claims.cnf.jkt === "string"
      ? claims.cnf.jkt
      : null;
  if (
    claims.identity_type !== "machine" ||
    claims.token_type !== "machine" ||
    claims.aud !== WELDALL_RESOURCE ||
    typeof claims.client_id !== "string" ||
    !claims.client_id ||
    claims.sub !== `machine:${claims.client_id}` ||
    claims.azp !== claims.client_id ||
    !keyThumbprint
  ) {
    throw new WeldallAuthError("invalid_token", "invalid machine token", 401);
  }
  if (!granted.includes(requiredScope)) {
    throw new WeldallAuthError("insufficient_scope", `${requiredScope} is required`, 403, [
      requiredScope,
    ]);
  }
  try {
    await verifyStrictDpop(proof, {
      method: request.method,
      url: canonicalWeldallApiRequestUrl(request),
      replay: store,
      expectedJkt: keyThumbprint,
      accessToken: token,
    });
  } catch (error) {
    if (error instanceof WeldallAuthError && error.code === "invalid_dpop_proof") {
      throw new WeldallAuthError(error.code, error.message, 401);
    }
    throw error;
  }
  const machine = await db.machineClient.findUnique({
    where: { clientId: claims.client_id },
    include: { keys: true, allowedScopes: { include: { scope: true } } },
  });
  const key = machine?.keys.find(
    (item) => item.thumbprint === keyThumbprint && item.revokedAt === null,
  );
  if (
    !machine?.enabled ||
    machine.deactivatedAt ||
    !key ||
    !machine.allowedScopes.some(({ scope }) => scope.key === requiredScope)
  ) {
    throw new WeldallAuthError("invalid_token", "machine authorization is no longer active", 401);
  }
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
