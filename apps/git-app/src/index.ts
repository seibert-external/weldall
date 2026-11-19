import { serve } from "@hono/node-server";
import { GitAppConfigError } from "./config.js";
import { jsonLogger } from "./log.js";
import { prepareGitApp, startupErrorMessage } from "./start.js";

/**
 * How long running requests may finish after a stop signal; below Docker's default stop timeout
 * (10 s), so the process exits on its own before it is killed. Transfers still running then are
 * cut off (see the README's Docker image section).
 */
const SHUTDOWN_GRACE_MS = 8_000;

/** Ends a failed start with the clean message (variables only, never a value) and exit code 1. */
function failStart(error: unknown): never {
  process.stderr.write(`${startupErrorMessage(error)}\n`);
  process.exit(1);
}

let prepared;
try {
  prepared = await prepareGitApp();
} catch (error) {
  failStart(error);
}
const { config, app } = prepared;
const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) =>
  jsonLogger("info", "Git app listening", {
    port,
    host: config.host.kind,
    organization: config.host.config.organization,
    origin: config.publicOrigin,
  }),
);
// A port in use or not permitted is a start-up failure too, not an uncaught error event.
const onListenError = () =>
  failStart(new GitAppConfigError(["PORT cannot be listened on (in use or not permitted)."]));
server.once("error", onListenError);
server.once("listening", () => server.off("error", onListenError));

// In a container the process is PID 1, which ignores signals it does not handle: without this,
// `docker stop` waits for its timeout and kills the process.
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    jsonLogger("info", "Git app stopping", { signal });
    // No exit in the close callback: completion audits of finished transfers are sent without
    // being awaited, so the process ends when the event loop drains, at the latest after the grace.
    server.close();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  });
