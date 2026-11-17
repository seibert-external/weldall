import { createDpopProof } from "@weldall/sdk";
import { z } from "zod";
import type { WeldallConfig } from "./config.js";
import { CliError, errorMessage } from "./errors.js";
import { responseValue } from "./http.js";
import { terminalText } from "./output.js";
import { withAccess } from "./services/auth.js";

/** The checks call the Git host several times; the server bounds each call to 15 s. */
export const CONNECTOR_CHECK_TIMEOUT_MS = 90_000;
/** Exit code when a required check failed; the output lists which. */
export const CONNECTOR_CHECK_FAILED_EXIT_CODE = 3;

const text = (maximum: number) => z.string().max(maximum);
const report = z.object({
  connector: z.object({ key: text(200), name: text(200), type: text(100) }),
  repository: z.object({ owner: text(200), name: text(200) }).nullable(),
  checks: z
    .array(
      z.object({
        id: text(200),
        title: text(200),
        state: z.enum(["pass", "fail", "unverifiable"]),
        required: z.boolean(),
        reason: text(2_000),
        action: text(2_000).nullable(),
      }),
    )
    .max(200),
  summary: z.object({
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    unverifiable: z.number().int().nonnegative(),
  }),
});
export type ConnectorCheckReport = z.output<typeof report>;

/** One GET below the issuer; returns status and parsed body, throws only when it cannot ask. */
export type ConnectorCheckSend = (path: string) => Promise<{ status: number; body: unknown }>;

const UPDATE_HINT =
  "Ask your Weldall administrator to update the server; `weldall connectors check` needs a newer Weldall server.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Asks the server to run the checklist of one Git host connector; administrators only. */
export async function readConnectorCheck({
  connector,
  send,
}: {
  connector: string;
  send: ConnectorCheckSend;
}): Promise<ConnectorCheckReport> {
  let answer: { status: number; body: unknown };
  try {
    answer = await send(`/api/admin/connectors/${encodeURIComponent(connector)}/check`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new CliError(
      timedOut
        ? "Weldall did not finish the checks in time."
        : `Could not reach Weldall (${errorMessage(error)}).`,
      { cause: error, ...(timedOut ? { hint: "Run the check again." } : {}) },
    );
  }
  const body = isRecord(answer.body) ? answer.body : {};
  const code = typeof body.error === "string" ? body.error : null;
  const description =
    typeof body.error_description === "string"
      ? body.error_description.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 500)
      : null;
  // An older server answers the unknown route without a Weldall error body.
  if ((answer.status === 404 || answer.status === 405) && code === null)
    throw new CliError("This Weldall server cannot check connectors.", { hint: UPDATE_HINT });
  if (answer.status === 401)
    throw new CliError("Your Weldall login has expired.", {
      hint: "Run `weldall login`, then check again.",
    });
  if (answer.status === 403 && code === "forbidden")
    throw new CliError("Only Weldall administrators can check connectors.");
  if (code === "not_found")
    throw new CliError(`There is no connector "${terminalText(connector)}".`, {
      hint: "Use the connector key from the IaC manifest.",
    });
  if (answer.status < 200 || answer.status > 299)
    throw new CliError(
      `Checking the connector failed (HTTP ${answer.status})${description ? `: ${description}` : ""}`,
    );
  const parsed = report.safeParse(answer.body);
  if (!parsed.success)
    throw new CliError("Weldall returned an unexpected answer.", { hint: UPDATE_HINT });
  return parsed.data;
}

/** Signs the request with this device's CLI login (DPoP), like every other CLI call. */
export function directConnectorCheckSend(config: WeldallConfig): ConnectorCheckSend {
  return (path) => {
    const url = `${config.issuer}${path}`;
    return withAccess(config, async (session) => {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `DPoP ${session.accessToken}`,
          dpop: await createDpopProof({
            ...session.credentials,
            method: "GET",
            url,
            accessToken: session.accessToken,
          }),
        },
        redirect: "error",
        signal: AbortSignal.timeout(CONNECTOR_CHECK_TIMEOUT_MS),
      });
      return { status: response.status, body: await responseValue(response) };
    });
  };
}

const LABELS = { pass: "PASS", fail: "FAIL", unverifiable: "CANNOT VERIFY" } as const;

/** One line per check, the action indented below it; server texts are made terminal-safe. */
export function formatConnectorCheck(value: ConnectorCheckReport): string {
  const width = Math.max(...Object.values(LABELS).map((label) => label.length));
  const lines = [
    `Checks for connector "${terminalText(value.connector.key)}" (${terminalText(value.connector.type)})`,
    value.repository
      ? `Checks that need a repository used ${terminalText(`${value.repository.owner}/${value.repository.name}`)}.`
      : "No app repository exists yet: checks that need one cannot be verified.",
    "",
  ];
  for (const check of value.checks) {
    const title = `${terminalText(check.title)}${check.required ? "" : " (recommended)"}`;
    lines.push(`${LABELS[check.state].padEnd(width)}  ${title}: ${terminalText(check.reason)}`);
    if (check.action) lines.push(`${" ".repeat(width)}  To do: ${terminalText(check.action)}`);
  }
  const { pass, fail, unverifiable } = value.summary;
  lines.push("", `${pass} passed, ${fail} failed, ${unverifiable} cannot be verified.`);
  return lines.join("\n");
}

/** True when a required check failed; recommendations and unverifiable checks do not count. */
export const requiredCheckFailed = (value: ConnectorCheckReport) =>
  value.checks.some((check) => check.required && check.state === "fail");
