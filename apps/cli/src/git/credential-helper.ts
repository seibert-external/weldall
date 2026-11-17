/**
 * Git's credential helper protocol for Weldall's git proxy (`weldall git-credential get|store|
 * erase`). Git starts the helper per command and talks to it over stdin/stdout, so stdout carries
 * nothing but protocol lines and every message goes to stderr. The helper stores nothing: `store`
 * and `erase` are ignored, and a credential lives only in the git process that asked for it.
 *
 * Measured with Apple Git 2.39.3: `get` receives `protocol`, `host` and, with
 * `credential.useHttpPath=true`, `path` (no leading slash); unknown keys in the answer are
 * ignored. `quit=1` stops git at once without any prompt, whatever the environment.
 */

export type GitAccess = "read" | "write";

/**
 * Selects the access the helper requests. Git does not tell a helper whether it will push, so
 * the default is `read`; the publish step sets `write` for its push only.
 */
export const GIT_ACCESS_ENV = "WELDALL_GIT_ACCESS";

export interface GitCredentialRequest {
  /** `git/<connector>/<owner>/<repository>.git`, as git sends it. */
  path: string;
  access: GitAccess;
}

/** Weldall's answer as received: the HTTP status and the parsed body (JSON, text, or null). */
export interface WeldallAnswer {
  status: number;
  body: unknown;
}

export type GitCredentialFailureKind = "login" | "network" | "configuration";

/** Weldall could not be asked: no or expired login, an unreachable server, a bad configuration. */
export class GitCredentialFailure extends Error {
  constructor(
    readonly kind: GitCredentialFailureKind,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitCredentialFailure";
  }
}

/**
 * How the helper reaches Weldall. The direct variant (`weldall-access.ts`) uses this device's
 * CLI login; a sandboxed agent gets a variant through the sandbox door (INV-133) instead, and the
 * protocol code below stays unchanged.
 */
export interface WeldallGitCredentialAccess {
  /** Origin of the Weldall server this helper answers for; null when none is configured. */
  issuer(): Promise<string | null>;
  /** Asks Weldall for a git credential; throws `GitCredentialFailure` when it cannot ask. */
  requestCredential(request: GitCredentialRequest): Promise<WeldallAnswer>;
}

interface Input {
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>;
}
interface Output {
  write(chunk: string): unknown;
}

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_DETAIL_CHARS = 300;
const CREDENTIAL_PREFIX = "wgc_";
const LOGIN_HINT = "Run `weldall login`, then retry the git command.";

/** Reads git's `key=value` lines until a blank line or the end of input. */
export async function readCredentialInput(input: Input): Promise<string> {
  let text = "";
  for await (const chunk of input) {
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const end = text.search(/(^|\n)\n/);
    if (end !== -1) return text.slice(0, end);
    if (text.length > MAX_INPUT_BYTES) break;
  }
  return text;
}

/** Parses git's credential attributes; a repeated key keeps its last value. */
export function parseCredentialAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    attributes.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return attributes;
}

const connectorKey = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const hostName = /^[A-Za-z0-9._-]{1,100}$/;

/** Whether `path` is a git proxy repository path (`git/<connector>/<owner>/<repository>.git`). */
export function isGitProxyPath(path: string): boolean {
  const segments = (path.startsWith("/") ? path.slice(1) : path).split("/");
  if (segments.length !== 4 || segments[0] !== "git") return false;
  const [, key = "", owner = "", repository = ""] = segments;
  if (!repository.endsWith(".git")) return false;
  const name = repository.slice(0, -4);
  return (
    connectorKey.test(key) &&
    hostName.test(owner) &&
    hostName.test(name) &&
    ![owner, name].some((part) => part === "." || part === "..")
  );
}

/** Compares git's `host` (with port when not 443) with the issuer origin's host. */
export function isIssuerHost(gitHost: string, issuer: string): boolean {
  if (!/^[A-Za-z0-9.:[\]-]{1,300}$/.test(gitHost)) return false;
  try {
    return new URL(`https://${gitHost}`).host === new URL(issuer).host;
  } catch {
    return false;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Server text for stderr: one bounded line without control characters. */
const detail = (value: unknown): string | null => {
  if (!isRecord(value) || typeof value.error_description !== "string") return null;
  const text = value.error_description
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .trim()
    .slice(0, MAX_DETAIL_CHARS);
  return text || null;
};

const errorCode = (value: unknown) =>
  isRecord(value) && typeof value.error === "string" ? value.error : null;

/** A readable reason for a failed answer; never contains a credential. */
export function describeRejection(answer: WeldallAnswer, issuer: string): string {
  const { status, body } = answer;
  const reason = detail(body);
  const withReason = (message: string) => (reason ? `${message} (${reason})` : message);
  const code = errorCode(body);
  if (status === 401)
    return `Your Weldall login for ${issuer} has expired or was revoked. ${LOGIN_HINT}`;
  if (status === 404 && code === null)
    return `${issuer} does not issue git credentials yet. Ask your Weldall administrator to update the server.`;
  if (status === 404)
    return withReason(
      "No app of yours uses this repository: it belongs to someone else's app, or the app does not exist",
    );
  if (status === 403) return withReason("Weldall denies you git access to this repository");
  if (status === 409 && code === "repository_not_ready")
    return withReason("The app's repository is not ready yet");
  if (status === 409 && code === "disabled")
    return withReason("The Git host connector is disabled in Weldall");
  if (status === 429)
    return withReason("Too many git credentials requested. Wait a minute, then retry");
  if (status === 400) return withReason("Weldall rejected the request for a git credential");
  return withReason(`Weldall could not issue a git credential (HTTP ${status})`);
}

const protocolValue = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1000 && !/[\0\r\n]/.test(value);

/** The credential lines for git, or null when the answer is not a usable credential. */
export function credentialLines(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const { username, password, expiresAt } = body;
  if (!protocolValue(username) || !protocolValue(password)) return null;
  if (!password.startsWith(CREDENTIAL_PREFIX)) return null;
  const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  return [
    `username=${username}`,
    `password=${password}`,
    // Known since Git 2.41; older versions ignore unknown keys.
    ...(Number.isFinite(expiry) ? [`password_expiry_utc=${Math.floor(expiry / 1000)}`] : []),
    "",
  ].join("\n");
}

function accessFrom(environment: NodeJS.ProcessEnv): GitAccess | null {
  const value = environment[GIT_ACCESS_ENV];
  if (value === undefined || value === "" || value === "read") return "read";
  return value === "write" ? "write" : null;
}

export interface GitCredentialHelperOptions {
  operation: string;
  input: Input;
  output: Output;
  errors: Output;
  environment: NodeJS.ProcessEnv;
  weldall: WeldallGitCredentialAccess;
}

/**
 * Runs one helper invocation. For `get` it answers only for the configured Weldall host and a git
 * proxy path; for every other host it prints nothing, so git asks its other helpers. When the
 * credential cannot be obtained it prints `quit=1` so git stops without prompting, and says why
 * on stderr. It never throws.
 */
export async function runGitCredentialHelper({
  operation,
  input,
  output,
  errors,
  environment,
  weldall,
}: GitCredentialHelperOptions): Promise<void> {
  const say = (message: string) => errors.write(`weldall git-credential: ${message}\n`);
  let text: string;
  try {
    text = await readCredentialInput(input);
  } catch {
    say("could not read the request from git.");
    return;
  }
  // `store` and `erase` are ignored: the helper keeps nothing. Unknown operations are ignored too.
  if (operation !== "get") return;

  const attributes = parseCredentialAttributes(text);
  if (attributes.get("protocol") !== "https") return;
  const host = attributes.get("host") ?? "";

  let issuer: string | null;
  try {
    issuer = await weldall.issuer();
  } catch (error) {
    say(`could not read the Weldall configuration: ${messageOf(error)}`);
    return;
  }
  if (!issuer) {
    say(
      "no Weldall server is configured, so no credential is given. Set WELDALL_ISSUER or run `weldall config set-issuer <https://host>`.",
    );
    return;
  }
  if (!isIssuerHost(host, issuer)) return;

  const path = attributes.get("path");
  if (path === undefined || !isGitProxyPath(path)) {
    say(
      path === undefined
        ? "git did not send the repository path. Set credential.useHttpPath=true for the Weldall git URL."
        : "this URL is not a Weldall git repository (expected /git/<connector>/<owner>/<repository>.git).",
    );
    return;
  }

  const quit = (message: string) => {
    output.write("quit=1\n");
    say(message);
  };
  const access = accessFrom(environment);
  if (!access) {
    quit(`${GIT_ACCESS_ENV} must be "read" or "write".`);
    return;
  }

  let answer: WeldallAnswer;
  try {
    answer = await weldall.requestCredential({ path, access });
  } catch (error) {
    quit(failureMessage(error, issuer));
    return;
  }
  if (answer.status < 200 || answer.status > 299) {
    quit(describeRejection(answer, issuer));
    return;
  }
  const lines = credentialLines(answer.body);
  if (!lines) {
    quit("Weldall returned an invalid git credential.");
    return;
  }
  output.write(lines);
}

const messageOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "unexpected failure";

function failureMessage(error: unknown, issuer: string): string {
  if (!(error instanceof GitCredentialFailure))
    return `Getting a git credential failed: ${messageOf(error)}`;
  if (error.kind === "login")
    return `You are not logged in to ${issuer}, or the login has expired (${error.message}). ${LOGIN_HINT}`;
  if (error.kind === "network") return `Could not reach ${issuer}: ${error.message}`;
  return `The Weldall configuration is not usable: ${error.message}`;
}
