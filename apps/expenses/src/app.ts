import { readFile } from "node:fs/promises";
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
    allowedOrigins: [env.downstreamIssuer],
    allowedMethods: ["GET", "POST", "DELETE"],
    skills: {
      items: [
        {
          id: "review",
          title: "Review expenses",
          requiredScopes: ["expenses:read"],
          visibility: "DEFAULT",
          content:
            "# Review expenses\n\nUse `weldall request --scope expenses:read` with the Expenses API to list expenses.",
        },
      ],
    },
  });
  const app = new Hono<{ Variables: WeldallVariables }>();
  weldall.registerRoutes(app);
  app.options("/api/expenses", weldall.preflight(["GET", "POST"]));
  app.options("/api/expenses/:id", weldall.preflight(["DELETE"]));
  if (
    process.env.NODE_ENV !== "production" ||
    process.env.WELDALL_BROWSER_FIXTURE_ENABLED === "true"
  ) {
    const securityHeaders = {
      "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${WELDALL_ISSUER}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    };
    app.get("/weldall-browser", (c) =>
      c.html(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Expenses Weldall browser connection</title><link rel="stylesheet" href="/weldall-browser/app.css"></head><body><main><h1>Expenses browser connection</h1><p class="warning">Development fixture. Approve only the code shown for this exact Expenses origin.</p><p id="support" class="status">Checking browser capabilities…</p><p>Identity: <strong id="identity">Not connected</strong></p><code id="command" aria-live="polite"></code><div class="controls"><button id="connect">Start connection</button><button id="local-status">Local status</button><button id="remote-status">Verify remotely</button><button id="read">Read expenses</button><button id="create">Create expense</button><button id="disconnect">Disconnect remotely</button><button id="clear">Clear local credentials</button></div><pre id="output" aria-live="polite">Initializing…</pre></main><script type="module" src="/weldall-browser/app.js"></script></body></html>`,
        200,
        securityHeaders,
      ),
    );
    app.get("/weldall-browser/config", (c) =>
      c.json(
        {
          issuer: WELDALL_ISSUER,
          resource: env.downstreamResourceIdentifier,
          apiEndpoint: `${env.downstreamIssuer}/api/expenses`,
        },
        200,
        securityHeaders,
      ),
    );
    app.get("/weldall-browser/app.js", async (c) =>
      c.body(
        await readFile(new URL("../public/weldall-browser.js", import.meta.url), "utf8"),
        200,
        {
          ...securityHeaders,
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        },
      ),
    );
    app.get("/weldall-browser/app.css", async (c) =>
      c.body(
        await readFile(new URL("../public/weldall-browser.css", import.meta.url), "utf8"),
        200,
        {
          ...securityHeaders,
          "content-type": "text/css; charset=utf-8",
          "cache-control": "no-store",
        },
      ),
    );
    app.get("/weldall-browser/sdk/:file", async (c) => {
      const file = c.req.param("file");
      if (!/^[a-z][a-z0-9-]*\.js$/u.test(file)) return c.notFound();
      try {
        return c.body(
          await readFile(
            process.env.WELDALL_BROWSER_DIST_DIR
              ? new URL(file, `file://${process.env.WELDALL_BROWSER_DIST_DIR.replace(/\/$/u, "")}/`)
              : new URL(`../../../packages/browser/dist/${file}`, import.meta.url),
            "utf8",
          ),
          200,
          {
            ...securityHeaders,
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
          },
        );
      } catch {
        return c.notFound();
      }
    });
  }
  app.get("/api/expenses", weldall.protect({ scopes: ["expenses:read"] }, ["GET", "POST"]), (c) => {
    const auth = weldall.getAuth(c);
    return c.json({
      expenses: [
        {
          id: "expense-1",
          description: "Team lunch",
          amount: 18.5,
          currency: "EUR",
        },
      ],
      subject: auth.subject,
      requestedBy: auth.identity.type === "machine" ? auth.identity.clientId : auth.identity.email,
      identityType: auth.identityType,
      ...(auth.identityType === "user" ? { email: auth.email } : {}),
    });
  });
  app.post(
    "/api/expenses",
    weldall.protect({ scopes: ["expenses:create"] }, ["GET", "POST"]),
    async (c) => c.json({ id: "expense-new", ...(await c.req.json()) }, 201),
  );
  app.delete(
    "/api/expenses/:id",
    weldall.protect({ scopes: ["expenses:delete", "expenses:write"] }, ["DELETE"]),
    (c) => c.json({ deleted: c.req.param("id") }),
  );
  return app;
};
