import { createDpopProof } from "@weldall/sdk";
import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { successfulResponse, successfulResponseStream, isRecord } from "../http.js";
import { withAccess } from "./auth.js";
import { browserOpener } from "./browser.js";
import type { PreparedRequest } from "./resources.js";

/** Only Weldall credentials are used here. Provider tokens never leave the server. */
export async function connectionApi(
  config: WeldallConfig,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const url = `${config.issuer}/api/me/${path}`;
  return withAccess(config, async (session) =>
    successfulResponse(
      await fetch(url, {
        method,
        headers: {
          authorization: `DPoP ${session.accessToken}`,
          dpop: await createDpopProof({
            ...session.credentials,
            method,
            url,
            accessToken: session.accessToken,
          }),
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }),
      "Weldall connection request",
    ),
  );
}
export async function connectAccount(
  config: WeldallConfig,
  connector: string,
  name: string,
  reconnect?: string,
) {
  const attempt = await connectionApi(config, "connections", "POST", {
    connector,
    name,
    ...(reconnect ? { reconnect } : {}),
  });
  if (!isRecord(attempt) || typeof attempt.id !== "string" || typeof attempt.setupUrl !== "string")
    throw new CliError("Invalid connection setup response");
  const url = new URL(attempt.setupUrl);
  if (
    url.origin !== config.issuer ||
    url.pathname !== `/connections/setup/${attempt.id}` ||
    url.search ||
    url.hash
  )
    throw new CliError("Unsafe setup URL");
  console.error(
    `Open ${url.toString()}\nAttempt: ${attempt.id}. You can interrupt and check it with 'weldall connections status ${attempt.id}'.`,
  );
  await browserOpener(url.toString()).catch(() =>
    console.error("Open the setup URL manually in your browser."),
  );
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const status = await connectionApi(
      config,
      `connection-authorizations/${encodeURIComponent(attempt.id)}`,
    );
    if (!isRecord(status) || typeof status.status !== "string")
      throw new CliError("Invalid authorization status");
    if (status.status === "COMPLETED") return status.connection;
    if (!["SETUP", "AUTHORIZING", "PROCESSING"].includes(status.status))
      throw new CliError(`Authorization status: ${status.status}`, {
        hint:
          status.status === "NEEDS_REVOCATION"
            ? `Run weldall connections cancel ${attempt.id} to revoke the unused grant. Google revocation may affect other authorizations for this account/client.`
            : "Start a new connection attempt.",
      });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new CliError("Connection setup timed out", {
    hint: `Check weldall connections status ${attempt.id}. Completed connections remain available even if the CLI was interrupted.`,
  });
}
export function validateConnectionTarget(config: WeldallConfig, raw: string): URL {
  const url = new URL(raw);
  if (
    url.origin !== config.issuer ||
    !/^\/connectors\/[a-z0-9][a-z0-9._-]{0,119}\//.test(url.pathname) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new CliError(
      "Connection requests must use this Weldall installation's /connectors/<key>/ URL",
    );
  return url;
}
export async function connectionRequest(
  config: WeldallConfig,
  selector: string,
  input: PreparedRequest,
) {
  const url = validateConnectionTarget(config, input.url);
  return withAccess(config, async (session) => {
    const headers = new Headers(input.headers);
    headers.set("authorization", `DPoP ${session.accessToken}`);
    headers.set(
      "dpop",
      await createDpopProof({
        ...session.credentials,
        method: input.method,
        url: url.toString(),
        accessToken: session.accessToken,
      }),
    );
    headers.set("x-weldall-connection", selector);
    if (input.json !== undefined) headers.set("content-type", "application/json");
    return successfulResponseStream(
      await fetch(url, {
        method: input.method,
        headers,
        ...(input.json !== undefined
          ? { body: JSON.stringify(input.json) }
          : input.body !== undefined
            ? { body: input.body }
            : {}),
        redirect: "error",
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      }),
      "Weldall connector request",
    );
  });
}
