import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
const app = await createApp();
serve({ fetch: app.fetch, port: 3001 }, ({ port }) =>
  console.log(`Expenses listening on http://localhost:${port}`),
);
