import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { getEnv } from "./env.js";

const app = createApp(await getEnv());
const port = Number(process.env.DEV_IDP_PORT ?? "3002");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid DEV_IDP_PORT");
serve({ fetch: app.fetch, port }, ({ port }) =>
  console.log(`Development IdP listening on http://localhost:${port}`),
);
