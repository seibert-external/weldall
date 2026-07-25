import { Hono, type Context } from "hono";
import {
  JWT_DPOP_DRAFT,
  JWT_DPOP_GRANT,
  OAuthError,
  ReplayStore,
  dpopResource,
  issueAccessToken,
  oauthErrorResponse,
  verifyIdJag,
  verifyStrictDpop,
  WELDALL_ISSUER,
} from "@weldall/oauth";
import { getEnv } from "./env.js";
export const createApp = async () => {
  const env = await getEnv();
  const issuer = env.downstreamIssuer;
  const resourceIdentifier = env.downstreamResourceIdentifier;
  const clientId = env.downstreamClientId;
  const tokenEndpoint = `${issuer}/oauth/token`;
  const proofReplay = new ReplayStore();
  const jagReplay = new ReplayStore(10_000, {
    code: "invalid_grant",
    message: "ID-JAG was already used",
  });
  const app = new Hono();
  app.onError((e) => oauthErrorResponse(e));
  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer,
      token_endpoint: tokenEndpoint,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      grant_types_supported: [JWT_DPOP_GRANT],
      dpop_signing_alg_values_supported: ["ES256"],
      "urn:weldall:jwt-dpop-draft": JWT_DPOP_DRAFT,
    }),
  );
  const protectedResourceMetadata = (c: Context) =>
    c.json({
      resource: resourceIdentifier,
      authorization_servers: [issuer],
      scopes_supported: env.downstreamScopes,
      bearer_methods_supported: ["header"],
      dpop_signing_alg_values_supported: ["ES256"],
    });
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/api", protectedResourceMetadata);
  app.get("/.well-known/jwks.json", (c) =>
    c.json({
      keys: [{ ...env.expensesPublicJwk, kid: env.EXPENSES_SIGNING_KID, alg: "ES256", use: "sig" }],
    }),
  );
  app.post("/oauth/token", async (c) => {
    const form = await c.req.parseBody({ all: true });
    if (Array.isArray(form.grant_type) || Array.isArray(form.assertion))
      throw new OAuthError("invalid_request", "duplicate OAuth parameter");
    if (form.grant_type !== JWT_DPOP_GRANT || typeof form.assertion !== "string")
      throw new OAuthError("unsupported_grant_type");
    const jag = await verifyIdJag(form.assertion, {
      issuer: WELDALL_ISSUER,
      audience: issuer,
      resource: resourceIdentifier,
      clientId,
      kid: env.WELDALL_SIGNING_KID,
      publicJwk: env.weldallPublicJwk,
      allowedScopes: env.downstreamScopes,
    });
    const proof = c.req.header("dpop");
    if (!proof) throw new OAuthError("invalid_dpop_proof");
    await verifyStrictDpop(proof, {
      method: "POST",
      url: tokenEndpoint,
      replay: proofReplay,
      expectedJkt: jag.cnf.jkt,
    });
    jagReplay.consume(jag.jti, (jag.exp + 6) * 1000);
    const scopes = jag.scope.split(" ");
    const token = await issueAccessToken({
      issuer,
      subject: jag.sub,
      resource: resourceIdentifier,
      clientId,
      scopes,
      jkt: jag.cnf.jkt,
      kid: env.EXPENSES_SIGNING_KID,
      privateJwk: env.expensesPrivateJwk,
    });
    return c.json(
      { access_token: token, token_type: "DPoP", expires_in: 600, scope: jag.scope },
      { headers: { "cache-control": "no-store" } },
    );
  });
  const protect = (scopes: string[]) =>
    dpopResource({
      issuer,
      resource: resourceIdentifier,
      publicOrigin: issuer,
      kid: env.EXPENSES_SIGNING_KID,
      publicJwk: env.expensesPublicJwk,
      clientId,
      requiredScopes: scopes,
      replay: proofReplay,
    });
  app.get("/api/expenses", protect(["expenses:read"]), (c) =>
    c.json({
      expenses: [
        { id: "expense-1", description: "Prototype lunch", amount: 18.5, currency: "EUR" },
      ],
      subject: (c as any).get("oauthSubject"),
    }),
  );
  app.post("/api/expenses", protect(["expenses:create"]), async (c) =>
    c.json({ id: "expense-new", ...(await c.req.json()) }, 201),
  );
  app.delete("/api/expenses/:id", protect(["expenses:delete", "expenses:write"]), (c) =>
    c.json({ deleted: c.req.param("id") }),
  );
  return app;
};
