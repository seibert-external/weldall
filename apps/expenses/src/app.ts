import { Hono } from "hono";
import { inMemory, type AuthContext } from "@weldall/sdk";
import { createNativeMcp, createMcpAppResource } from "@weldall/sdk/mcp/server";
import { initWeldall, type WeldallVariables } from "@weldall/sdk/hono";
import { WELDALL_ISSUER } from "./constants.js";
import { getEnv } from "./env.js";
import { reviewExpensesSkill } from "./review-skill.js";
import { renderExpensesUi, expensesUiCss } from "./expenses-ui.js";

const listExpenses = (auth: AuthContext) => ({
  expenses: [{ id: "expense-1", description: "Team lunch", amount: 18.5, currency: "EUR" }],
  subject: auth.subject,
  requestedBy: auth.identity.type === "machine" ? auth.identity.clientId : auth.identity.email,
  identityType: auth.identityType,
  ...(auth.identityType === "user" ? { email: auth.email } : {}),
});

export const createApp = async () => {
  const env = await getEnv();
  const expensesUi = createMcpAppResource({
    name: "expenses",
    scopes: ["expenses:read"],
    resourceOrigin: env.downstreamIssuer,
    displayModes: ["inline", "fullscreen", "pip"],
    styleUrls: [new URL("/mcp-ui/expenses.css", env.downstreamIssuer).href],
    render: ({ auth }) => renderExpensesUi(listExpenses(auth)),
  });
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
    mcp: createNativeMcp({
      path: "/api/mcp",
      description: "List and review expenses",
      discoveryScopes: ["expenses:read"],
      tools: [
        {
          name: "list_expenses",
          _meta: { ui: { resourceUri: expensesUi.uri } },
          description: "List expenses visible to the verified caller",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          scopes: ["expenses:read"],
          annotations: { readOnlyHint: true, destructiveHint: false },
          async handler(_, { auth }) {
            const result = listExpenses(auth);
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: result,
            };
          },
        },
        {
          name: "create_expense",
          description: "Create a demonstration expense (not persisted)",
          inputSchema: {
            type: "object",
            properties: { description: { type: "string", minLength: 1, maxLength: 200 } },
            required: ["description"],
            additionalProperties: false,
          },
          scopes: ["expenses:create"],
          annotations: { readOnlyHint: false, destructiveHint: false },
          async handler(args) {
            return {
              content: [{ type: "text", text: JSON.stringify({ id: "expense-new", ...args }) }],
            };
          },
        },
      ],
      resources: [
        expensesUi,
        {
          uri: "expenses://current",
          name: "Current expenses",
          mimeType: "application/json",
          scopes: ["expenses:read"],
          async handler({ auth }) {
            return {
              contents: [
                {
                  uri: "expenses://current",
                  mimeType: "application/json",
                  text: JSON.stringify(listExpenses(auth)),
                },
              ],
            };
          },
        },
      ],
    }),
    skills: {
      items: [reviewExpensesSkill(env.downstreamIssuer)],
    },
  });
  const app = new Hono<{ Variables: WeldallVariables }>();
  weldall.registerRoutes(app);
  app.get("/mcp-ui/expenses.css", (c) =>
    c.body(expensesUiCss, 200, {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "public, max-age=300",
    }),
  );
  app.get("/api/expenses", weldall.protect({ scopes: ["expenses:read"] }), (c) => {
    const auth = weldall.getAuth(c);
    return c.json(listExpenses(auth));
  });
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
