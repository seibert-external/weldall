import type { MiddlewareHandler } from "hono";
import type { JWK } from "jose";
import { OAuthError } from "./errors.js";
import { ReplayStore } from "./replay.js";
import { verifyStrictDpop } from "./dpop.js";
import { verifyAccessToken } from "./resource-as.js";
export const dpopResource =
  (input: {
    issuer: string;
    resource: string;
    publicOrigin: string;
    kid: string;
    publicJwk: JWK;
    clientId: string;
    requiredScopes: readonly string[];
    replay: ReplayStore;
  }): MiddlewareHandler =>
  async (c, next) => {
    const auth = c.req.header("authorization");
    const proof = c.req.header("dpop");
    if (!auth?.startsWith("DPoP ") || !proof || auth.includes(","))
      throw new OAuthError("invalid_token", "DPoP authorization required", 401);
    const token = auth.slice(5);
    const payload = await verifyAccessToken(token, { ...input });
    try {
      await verifyStrictDpop(proof, {
        method: c.req.method,
        url: new URL(c.req.path, `${input.publicOrigin}/`).toString(),
        replay: input.replay,
        accessToken: token,
        expectedJkt: payload.cnf.jkt,
      });
    } catch (error) {
      if (error instanceof OAuthError && error.code === "invalid_dpop_proof")
        throw new OAuthError(error.code, error.message, 401);
      throw error;
    }
    c.set("oauthSubject", payload.sub);
    c.set("oauthScopes", payload.scope.split(" "));
    await next();
  };
