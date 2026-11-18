import { serve } from "@hono/node-server";
import { createGitApp } from "./app.js";
import { GitAppConfigError, loadConfig } from "./config.js";
import { jsonLogger } from "./log.js";

let config;
try {
  config = await loadConfig();
} catch (error) {
  // The message names variables only, never their values.
  process.stderr.write(
    `${error instanceof GitAppConfigError ? error.message : "Invalid Git app configuration."}\n`,
  );
  process.exit(1);
}
const app = createGitApp({ config });
serve({ fetch: app.fetch, port: config.port }, ({ port }) =>
  jsonLogger("info", "Git app listening", {
    port,
    host: config.host.kind,
    organization: config.host.config.organization,
    origin: config.publicOrigin,
  }),
);
