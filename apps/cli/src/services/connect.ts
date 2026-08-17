import { createInterface } from "node:readline/promises";
import { createDpopProof } from "@weldall/sdk";
import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { isRecord, responseValue } from "../http.js";
import { printFields, printWarning, success, terminalText } from "../output.js";
import { withLock } from "../storage/lock.js";
import { withAccess, type AccessSession } from "./auth.js";

const USER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export type BrowserConnectionApprovalContext = {
  requestId: string;
  userCode: string;
  origin: string;
  resource: { id: string; key: string; name: string; identifier: string };
  browserClientId: string;
  expiresAt: string;
  account: { id: string; email: string };
};

export type ConnectDependencies = {
  fetcher?: typeof fetch;
  lock?: <T>(operation: () => Promise<T>) => Promise<T>;
  access?: <T>(
    config: WeldallConfig,
    operation: (session: AccessSession) => Promise<T>,
  ) => Promise<T>;
  confirm?: (context: BrowserConnectionApprovalContext) => Promise<boolean>;
};

export function normalizeConnectionCode(raw: string): string {
  const compact = raw.trim().toUpperCase().replaceAll(/[\s-]/g, "");
  if (
    compact.length !== 8 ||
    [...compact].some((character) => !USER_CODE_ALPHABET.includes(character))
  )
    throw new TypeError("Connection code must contain eight supported letters or numbers");
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function requireInteractiveConnectionApproval(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new CliError("Browser connections require interactive approval", {
      hint: "Run `weldall connect CODE` in an interactive terminal. Weldall never approves a browser connection automatically.",
    });
}

function exactHttpsOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

function exactHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function parseLookupContext(
  value: unknown,
  expectedCode: string,
): BrowserConnectionApprovalContext {
  if (!isRecord(value) || !isRecord(value.resource) || !isRecord(value.account))
    throw new CliError("Weldall returned invalid browser-connection details");
  const origin = exactHttpsOrigin(value.origin);
  const identifier = exactHttpsUrl(value.resource.identifier);
  const expiresAt = typeof value.expiresAt === "string" ? new Date(value.expiresAt) : null;
  if (
    typeof value.requestId !== "string" ||
    !value.requestId ||
    value.userCode !== expectedCode ||
    !origin ||
    typeof value.resource.id !== "string" ||
    !value.resource.id ||
    typeof value.resource.key !== "string" ||
    !value.resource.key ||
    typeof value.resource.name !== "string" ||
    !value.resource.name.trim() ||
    !identifier ||
    typeof value.browserClientId !== "string" ||
    value.browserClientId !== `weldall-browser:${value.resource.key}` ||
    !expiresAt ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= new Date() ||
    typeof value.account.id !== "string" ||
    !value.account.id ||
    typeof value.account.email !== "string" ||
    !value.account.email.trim()
  )
    throw new CliError("Weldall returned invalid browser-connection details");
  return {
    requestId: value.requestId,
    userCode: expectedCode,
    origin,
    resource: {
      id: value.resource.id,
      key: value.resource.key,
      name: value.resource.name.trim(),
      identifier,
    },
    browserClientId: value.browserClientId,
    expiresAt: expiresAt.toISOString(),
    account: { id: value.account.id, email: value.account.email.trim() },
  };
}

async function approvalRequest(
  endpoint: string,
  body: Record<string, unknown>,
  session: AccessSession,
  fetcher: typeof fetch,
  label: "lookup" | "decision",
): Promise<unknown> {
  const proof = await createDpopProof({
    ...session.credentials,
    method: "POST",
    url: endpoint,
    accessToken: session.accessToken,
  });
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `DPoP ${session.accessToken}`,
        "content-type": "application/json",
        dpop: proof,
      },
      body: JSON.stringify(body),
      redirect: "error",
    });
  } catch (error) {
    throw new CliError("Unable to contact Weldall for browser connection approval", {
      cause: error,
      hint: "Check the Weldall host and your network connection, then try again.",
    });
  }
  const value = await responseValue(response);
  if (response.ok) return value;
  if ([400, 404, 409, 410].includes(response.status))
    throw new CliError("Connection code is unavailable", {
      hint: "Start a new connection in the browser application and approve only the new code.",
    });
  if (response.status === 401)
    throw new CliError("Your Weldall session is no longer valid", {
      hint: "Run `weldall login`, then try the browser connection again.",
    });
  if (response.status === 403)
    throw new CliError("Your account cannot approve browser connections", {
      hint: "Ask an administrator to restore your weldall:login access.",
    });
  if (response.status === 429)
    throw new CliError("Too many browser connection attempts", {
      hint: "Wait before trying a newly generated connection code.",
    });
  throw new CliError(`Browser connection ${label} failed with HTTP ${response.status}`);
}

export async function promptForBrowserConnection(
  context: BrowserConnectionApprovalContext,
): Promise<boolean> {
  requireInteractiveConnectionApproval();
  printFields(
    [
      ["Code", context.userCode],
      ["Application origin", context.origin],
      ["Resource", `${context.resource.name} (${context.resource.identifier})`],
      ["Account", context.account.email],
      ["Expires", context.expiresAt],
    ],
    "Browser connection request",
  );
  printWarning(
    "Approve only if you started this connection in the application at the exact origin shown above.",
    "If the code or origin differs, answer no and start again from the application.",
  );
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await input.question("Approve this browser connection? Type yes or no: "))
        .trim()
        .toLowerCase();
      if (answer === "yes" || answer === "y" || answer === "approve") return true;
      if (answer === "no" || answer === "n" || answer === "deny") return false;
      console.log("Please type yes or no.");
    }
  } finally {
    input.close();
  }
}

export async function connectBrowserApplication(
  config: WeldallConfig,
  normalizedCode: string,
  dependencies: ConnectDependencies = {},
): Promise<{ approved: boolean; context: BrowserConnectionApprovalContext }> {
  const code = normalizeConnectionCode(normalizedCode);
  const endpoints = config.browserConnections;
  if (!endpoints)
    throw new CliError("This Weldall host does not support browser connections", {
      hint: "Ask the administrator to update Weldall, then start a new browser connection.",
    });
  const fetcher = dependencies.fetcher ?? fetch;
  const lock = dependencies.lock ?? withLock;
  const access = dependencies.access ?? withAccess;
  const confirm = dependencies.confirm ?? promptForBrowserConnection;
  return lock(() =>
    access(config, async (session) => {
      const context = parseLookupContext(
        await approvalRequest(
          endpoints.pendingLookup,
          { userCode: code },
          session,
          fetcher,
          "lookup",
        ),
        code,
      );
      if (context.account.id !== session.subject)
        throw new CliError("Weldall returned browser-connection details for another account");
      const approved = await confirm(context);
      const result = await approvalRequest(
        endpoints.pendingDecision,
        { userCode: code, approve: approved },
        session,
        fetcher,
        "decision",
      );
      if (!isRecord(result) || result.approved !== approved)
        throw new CliError("Weldall returned an inconsistent browser-connection decision");
      if (approved) success(`Approved the browser connection for ${terminalText(context.origin)}.`);
      else success(`Denied the browser connection for ${terminalText(context.origin)}.`);
      return { approved, context };
    }),
  );
}
