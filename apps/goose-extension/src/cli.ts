import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionError, type ErrorCode } from "./errors.js";

export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const CATALOG_TIMEOUT = 60_000;
export const REQUEST_TIMEOUT = 240_000;
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const KEYCHAIN_READ_FAILED = "Unable to read the Weldall session from the secure credential store";
const KEYCHAIN_RETRY_MS = [200, 500, 1200];

export function trustedDirectories(
  value: string,
  cwd: string,
  platform = process.platform,
): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  const inside = (candidate: string, base: string) => {
    const relative = p.relative(base, candidate);
    return (
      relative === "" ||
      (!relative.startsWith(`..${p.sep}`) && relative !== ".." && !p.isAbsolute(relative))
    );
  };
  return value.split(p.delimiter).filter(
    (entry) =>
      p.isAbsolute(entry) &&
      !/(?:^|[/\\])(?:node_modules|_npx|_cacache|\.npm|\.pnpm|\.yarn)(?:[/\\]|$)/i.test(entry) &&
      // A host launched from / must still be able to find system binaries.
      (cwd === p.parse(cwd).root || !inside(entry, cwd)),
  );
}

export async function resolveCli(env = process.env, cwd = process.cwd()): Promise<string> {
  const canonicalCwd = await realpath(cwd);
  const directories = trustedDirectories(env.PATH ?? env.Path ?? "", canonicalCwd);
  for (const directory of directories) {
    // .cmd/.bat require a shell and are intentionally not accepted on Windows.
    const candidate = path.join(
      directory,
      process.platform === "win32" ? "weldall.exe" : "weldall",
    );
    try {
      const canonical = await realpath(candidate);
      const parent = path.dirname(canonical);
      if (
        !trustedDirectories(parent, canonicalCwd).length ||
        !trustedDirectories(parent, PACKAGE_ROOT).length
      )
        continue;
      if (!(await stat(canonical)).isFile()) continue;
      await access(canonical, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return canonical;
    } catch {
      /* Keep looking in PATH for the local binary. */
    }
  }
  throw new ExtensionError("cli_missing");
}

export interface CliRunner {
  nativeDiscoveryVersion?: 1 | undefined;
  run(
    args: string[],
    signal?: AbortSignal,
    timeout?: number,
    maximumOutput?: number,
  ): Promise<string>;
}

export class WeldallCli implements CliRunner {
  nativeDiscoveryVersion?: 1;
  private readonly operations = new Set<AbortController>();
  private running = 0;
  private readonly waiting = new Set<(error?: ExtensionError) => void>();
  private readonly pending = new Set<Promise<string>>();
  private closed = false;
  constructor(
    readonly executable: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async initialize(): Promise<void> {
    const version = (await this.run(["--version"], undefined, 10_000)).trim();
    if (!/^0\.(?:20|2[1-9]|[3-9]\d|[1-9]\d{2,})\.(?:0|[1-9]\d*)$/.test(version))
      throw new ExtensionError("cli_version");
  }

  async loadOrganizationInstructions(): Promise<string> {
    const output = await this.run(["status", "--json"]);
    let status: unknown;
    try {
      status = JSON.parse(output);
    } catch {
      throw new ExtensionError("invalid_response");
    }
    if (typeof status !== "object" || status === null || Array.isArray(status))
      throw new ExtensionError("invalid_response");
    if (!Object.hasOwn(status, "organizationInstructions")) throw new ExtensionError("cli_context");
    const instructions = (status as Record<string, unknown>).organizationInstructions;
    if (instructions === null) throw new ExtensionError("organization_context");
    // Match the CLI's organization appendix bound; never silently truncate policy.
    if (typeof instructions !== "string" || instructions.length > 100_000)
      throw new ExtensionError("invalid_response");
    if ((status as Record<string, unknown>).nativeDiscoveryVersion === 1)
      this.nativeDiscoveryVersion = 1;
    else delete this.nativeDiscoveryVersion;
    return instructions;
  }

  async run(
    args: string[],
    signal?: AbortSignal,
    timeout = CATALOG_TIMEOUT,
    maximumOutput = MAX_OUTPUT_BYTES,
  ): Promise<string> {
    // Retries share one deadline, so waiting for a slot never extends a call past its timeout.
    const deadline = Date.now() + timeout;
    for (const pause of KEYCHAIN_RETRY_MS) {
      try {
        return await this.runOnce(args, signal, deadline, maximumOutput);
      } catch (error) {
        if (!(error instanceof ExtensionError && error.stderr?.startsWith(KEYCHAIN_READ_FAILED)))
          throw error;
        if (Date.now() + pause >= deadline) throw error;
        try {
          await delay(pause, undefined, { signal });
        } catch (delayError) {
          if (signal?.aborted) throw new ExtensionError("cancelled");
          throw delayError;
        }
      }
    }
    return this.runOnce(args, signal, deadline, maximumOutput);
  }

  private async runOnce(
    args: string[],
    signal: AbortSignal | undefined,
    deadline: number,
    maximumOutput: number,
  ): Promise<string> {
    if (
      !Number.isSafeInteger(maximumOutput) ||
      maximumOutput < 1 ||
      maximumOutput > 12 * 1024 * 1024
    )
      throw new ExtensionError("invalid_request");
    if (this.closed || signal?.aborted) throw new ExtensionError("cancelled");
    if (this.running < 4) this.running++;
    else await this.waitForSlot(signal, deadline);
    const timeout = deadline - Date.now();
    if (this.closed || signal?.aborted || timeout <= 0) {
      this.release();
      throw new ExtensionError(timeout <= 0 ? "busy" : "cancelled");
    }
    const controller = new AbortController();
    this.operations.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const env = { ...this.env, NO_COLOR: "1", TERM: "dumb" };
    for (const key of [
      "NODE_OPTIONS",
      "NODE_PATH",
      "BUN_OPTIONS",
      "WELDALL_DEBUG",
      "WELDALL_DEBUG_TIMINGS",
    ])
      delete env[key as keyof typeof env];
    const promise = new Promise<string>((resolve, reject) => {
      const child = spawn(this.executable, args, {
        cwd: path.parse(this.executable).root,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let errorBytes = 0;
      let failure: ExtensionError | undefined;
      let escalation: NodeJS.Timeout | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          /* The process may already have exited. */
        }
      };
      const stop = (code: ErrorCode) => {
        if (failure) return;
        failure = new ExtensionError(code);
        kill("SIGTERM");
        escalation = setTimeout(() => kill("SIGKILL"), 500);
      };
      const onAbort = () => stop("cancelled");
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => stop("timeout"), timeout);
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > maximumOutput) stop("output_limit");
        else if (!failure) stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        errorBytes += chunk.length;
        if (errorBytes > 16_384) stop("output_limit");
        else if (!failure) stderr.push(chunk);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        failure ??= new ExtensionError(
          ["ENOENT", "EACCES", "ENOEXEC"].includes(error.code ?? "") ? "cli_missing" : "cli_failed",
        );
      });
      child.on("close", (code) => {
        // A terminated parent can leave descendants that closed their inherited pipes.
        if (failure) kill("SIGKILL");
        clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        controller.signal.removeEventListener("abort", onAbort);
        if (failure) {
          reject(failure);
          return;
        }
        if (code !== 0) {
          reject(
            new ExtensionError("cli_failed", {
              exitCode: code,
              stderr: Buffer.concat(stderr).toString("utf8"),
            }),
          );
        } else resolve(Buffer.concat(stdout).toString("utf8"));
      });
    }).finally(() => {
      signal?.removeEventListener("abort", abort);
      this.operations.delete(controller);
      this.pending.delete(promise);
      this.release();
    });
    this.pending.add(promise);
    return promise;
  }

  // A model often fetches several records in parallel: calls beyond the four running
  // ones wait for a slot instead of failing. A call whose deadline passes while it
  // waits fails with busy, so a write never starts after its caller has given up.
  private waitForSlot(signal: AbortSignal | undefined, deadline: number): Promise<void> {
    if (this.waiting.size >= 16) return Promise.reject(new ExtensionError("busy"));
    return new Promise<void>((resolve, reject) => {
      const done = (error?: ExtensionError) => {
        clearTimeout(expiry);
        signal?.removeEventListener("abort", cancel);
        this.waiting.delete(done);
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => done(new ExtensionError("cancelled"));
      const expiry = setTimeout(() => done(new ExtensionError("busy")), deadline - Date.now());
      this.waiting.add(done);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  // Hands a freed slot to the oldest waiter, so no later call can take it first.
  private release(): void {
    const next = this.waiting.values().next().value;
    if (next) next();
    else this.running--;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const done of [...this.waiting]) done(new ExtensionError("cancelled"));
    for (const operation of this.operations) operation.abort();
    await Promise.allSettled([...this.pending]);
  }
}
