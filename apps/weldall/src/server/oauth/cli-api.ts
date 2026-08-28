import { db } from "@weldall/db";
import { WeldallAuthError, inMemory, verifyEs256, verifyStrictDpop } from "@weldall/sdk";
import { WELDALL_ISSUER, WELDALL_RESOURCE } from "./constants";
import { getWeldallSigningKey } from "./jwt";

const replay = inMemory({ suppressWarning: true });

export async function authenticateCliApiRequest(
  request: Request,
  input: { expectedUrl: string; requiredScope: string },
): Promise<{ id: string; email: string; name: string }> {
  const authorization = request.headers.get("authorization");
  const proof = request.headers.get("dpop");
  if (!authorization?.startsWith("DPoP ") || authorization.includes(",") || !proof) {
    throw new WeldallAuthError("invalid_token", "DPoP authorization required", 401);
  }
  const token = authorization.slice(5);
  const signingKey = await getWeldallSigningKey();
  const payload = await verifyEs256(token, {
    issuer: WELDALL_ISSUER,
    audience: WELDALL_RESOURCE,
    kid: signingKey.kid,
    publicJwk: signingKey.publicJwk,
    typ: "at+jwt",
    errorCode: "invalid_token",
    errorStatus: 401,
  });
  const jkt = (payload.cnf as { jkt?: unknown } | undefined)?.jkt;
  const granted = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
  if (
    typeof payload.sub !== "string" ||
    typeof jkt !== "string" ||
    !granted.includes(input.requiredScope)
  ) {
    throw new WeldallAuthError("insufficient_scope", `${input.requiredScope} is required`, 403);
  }
  try {
    await verifyStrictDpop(proof, {
      method: request.method,
      url: input.expectedUrl,
      replay,
      accessToken: token,
      expectedJkt: jkt,
    });
  } catch (error) {
    if (error instanceof WeldallAuthError && error.code === "invalid_dpop_proof") {
      throw new WeldallAuthError(error.code, error.message, 401);
    }
    throw error;
  }
  const user = await db.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, email: true, name: true, emailVerified: true },
  });
  if (!user?.emailVerified) {
    throw new WeldallAuthError("invalid_token", "unknown or unverified subject", 401);
  }
  return { id: user.id, email: user.email, name: user.name };
}
