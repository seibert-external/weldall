import { serve } from "@hono/node-server";
import { generateEs256KeyPair, inMemory } from "@weldall/sdk";
import { initWeldall, type WeldallVariables } from "@weldall/sdk/hono";
import { Hono } from "hono";

const key = await generateEs256KeyPair();
const weldall = initWeldall("https://weldall.example.com", {
  resource: "http://localhost:8787/api",
  publicOrigin: "http://localhost:8787",
  clientId: "weldall-cli-at-hono",
  supportedScopes: ["expenses:read"],
  signingKey: { kid: "development-only", privateJwk: key.privateJwk, publicJwk: key.publicJwk },
  replayStore: inMemory(),
  allowInsecureLoopback: true,
});
const app = new Hono<{ Variables: WeldallVariables }>();
weldall.registerRoutes(app);
app.get("/api/expenses", weldall.protect({ scopes: ["expenses:read"] }), (c) =>
  c.json({ subject: weldall.getAuth(c).identity.subject }),
);
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) });
