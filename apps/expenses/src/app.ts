import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inMemory, type AuthContext } from "@weldall/sdk";
import { createNativeMcp, createMcpAppResource } from "@weldall/sdk/mcp/server";
import { initWeldall, type WeldallVariables } from "@weldall/sdk/hono";
import { WELDALL_ISSUER } from "./constants.js";
import { getEnv } from "./env.js";
import { reviewExpensesSkill } from "./review-skill.js";
import { renderExpensesUi, expensesUiCss, expensesUiScript } from "./expenses-ui.js";

const listExpenses = (auth: AuthContext) => ({
  expenses: [{ id: "expense-1", description: "Team lunch", amount: 18.5, currency: "EUR" }],
  subject: auth.subject,
  requestedBy: auth.identity.type === "machine" ? auth.identity.clientId : auth.identity.email,
  identityType: auth.identityType,
  ...(auth.identityType === "user" ? { email: auth.email } : {}),
});

export const createApp = async () => {
  const env = await getEnv();
  // Serve the SDK's dependency-free browser module as a public asset on this resource's origin.
  const browserSdk = await readFile(
    new URL(import.meta.resolve("@weldall/sdk/mcp/browser")),
    "utf8",
  );
  const assetVersion = createHash("sha256")
    .update(browserSdk)
    .update(expensesUiScript)
    .update(expensesUiCss)
    .digest("hex")
    .slice(0, 16);
  const expensesUi = createMcpAppResource({
    name: "expenses",
    scopes: ["expenses:read"],
    resourceOrigin: env.downstreamIssuer,
    displayModes: ["inline", "fullscreen", "pip"],
    allowedTools: ["preview_expense_decision"],
    scriptUrls: [new URL(`/mcp-ui/expenses.js?v=${assetVersion}`, env.downstreamIssuer).href],
    styleUrls: [new URL(`/mcp-ui/expenses.css?v=${assetVersion}`, env.downstreamIssuer).href],
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
          name: "preview_expense_decision",
          description:
            "Simulate approving or denying the demo expense. Does not modify or persist anything.",
          inputSchema: {
            type: "object",
            properties: {
              expenseId: { const: "expense-1" },
              decision: { enum: ["approve", "deny"] },
            },
            required: ["expenseId", "decision"],
            additionalProperties: false,
          },
          // This only previews a decision; real approvals would require a write scope and record-level checks.
          scopes: ["expenses:read"],
          annotations: { readOnlyHint: true, openWorldHint: false },
          async handler(args) {
            const result = {
              expenseId: args.expenseId,
              decision: args.decision,
              simulated: true,
              persisted: false,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: result,
            };
          },
        },
        ...(env.downstreamScopes.includes("expenses:create")
          ? [
              {
                name: "create_expense",
                description: "Create a demonstration expense (not persisted)",
                inputSchema: {
                  type: "object" as const,
                  properties: { description: { type: "string", minLength: 1, maxLength: 200 } },
                  required: ["description"],
                  additionalProperties: false,
                },
                scopes: ["expenses:create"],
                annotations: { readOnlyHint: false, destructiveHint: false },
                async handler(args: Record<string, unknown>) {
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: JSON.stringify({ id: "expense-new", ...args }),
                      },
                    ],
                  };
                },
              },
            ]
          : []),
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
  app.get("/mcp-ui/expenses.js", (c) =>
    c.body(expensesUiScript, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300",
    }),
  );
  app.get("/mcp-ui/sdk.js", (c) =>
    c.body(browserSdk, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "access-control-allow-origin": "*",
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
