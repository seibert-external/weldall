import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { getEnv } from "./env.js";

const app = createApp(await getEnv());
serve({ fetch: app.fetch, port: 3002 }, ({ port }) =>
  console.log(`Development IdP listening on http://localhost:${port}`),
);
