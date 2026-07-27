import { Hono } from "hono";
import { inMemory } from "@weldall/sdk";
import { initWeldall, type WeldallVariables } from "@weldall/sdk/hono";
import { WELDALL_ISSUER } from "./constants.js";
import { getEnv } from "./env.js";

export const createApp = async () => {
  const env = await getEnv();
  const weldall = initWeldall(WELDALL_ISSUER, {
    resource: env.downstreamResourceIdentifier,
    publicOrigin: env.downstreamIssuer,
    clientId: env.downstreamClientId,
    supportedScopes: env.downstreamScopes,
    signingKey: {
      kid: env.EXPENSES_SIGNING_KID,
      privateJwk: env.expensesPrivateJwk,
      publicJwk: env.expensesPublicJwk,
    },
    replayStore: inMemory(),
  });
  const app = new Hono<{ Variables: WeldallVariables }>();
  weldall.registerRoutes(app);
  app.get("/api/expenses", weldall.protect({ scopes: ["expenses:read"] }), (c) =>
    c.json({
      expenses: [
        { id: "expense-1", description: "Prototype lunch", amount: 18.5, currency: "EUR" },
      ],
      subject: weldall.getAuth(c).subject,
      email: weldall.getAuth(c).email,
    }),
  );
  app.post("/api/expenses", weldall.protect({ scopes: ["expenses:create"] }), async (c) =>
    c.json({ id: "expense-new", ...(await c.req.json()) }, 201),
  );
  app.delete(
    "/api/expenses/:id",
    weldall.protect({ scopes: ["expenses:delete", "expenses:write"] }),
    (c) => c.json({ deleted: c.req.param("id") }),
  );
  return app;
};
