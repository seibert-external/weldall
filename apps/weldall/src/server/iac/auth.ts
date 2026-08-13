import { db, IAC_SCOPE_KEY } from "@weldall/db";
import { MACHINE_TOKEN_TYP, verifyStrictDpop, type ReplayStore } from "@weldall/sdk";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { WELDALL_ISSUER, WELDALL_RESOURCE } from "../oauth/constants";
import { auditRequestIdentifiers } from "../audit/service";
import { postgresReplayStore } from "../oauth/replay";
import type { IacActor } from "./service";

export async function requireIacMachine(
  request: Request,
  store: ReplayStore = postgresReplayStore,
): Promise<IacActor> {
  const authorization = request.headers.get("authorization");
  const proof = request.headers.get("dpop");
  if (!authorization?.startsWith("DPoP ") || !proof || proof.includes(","))
    throw new Response("Machine DPoP authorization required", { status: 401 });
  const token = authorization.slice(5);
  const header = decodeProtectedHeader(token);
  if (header.typ !== MACHINE_TOKEN_TYP)
    throw new Response("Invalid machine token", { status: 401 });
  const jwks = await db.jwks.findMany({ orderBy: { createdAt: "desc" } });
  let claims: Awaited<ReturnType<typeof jwtVerify>>["payload"] | undefined;
  for (const jwk of jwks) {
    try {
      ({ payload: claims } = await jwtVerify(
        token,
        await import("jose").then(({ importSPKI }) => importSPKI(jwk.publicKey, "ES256")),
        {
          issuer: WELDALL_ISSUER,
          audience: WELDALL_RESOURCE,
          algorithms: ["ES256"],
          requiredClaims: ["iss", "sub", "aud", "iat", "exp", "jti"],
          maxTokenAge: "5m",
        },
      ));
      break;
    } catch {
      /* try active signing keys */
    }
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
    url: request.url,
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
    ...auditRequestIdentifiers(request),
  };
}
