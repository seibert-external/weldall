import { spawn } from "node:child_process";
import { win32 } from "node:path";

const terminations = new WeakMap();

const waitForClose = (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("close", resolve);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.removeListener("close", resolve);
      resolve();
    }
  });
};

const waitForTool = (child) =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });

export function terminateProcessTree(
  child,
  {
    platform = process.platform,
    spawnProcess = spawn,
    systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
  } = {},
) {
  const existing = terminations.get(child);
  if (existing) return existing;
  const termination = (async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = waitForClose(child);
    if (platform === "win32" && child.pid !== undefined) {
      const taskkill = win32.join(systemRoot, "System32", "taskkill.exe");
      const killer = spawnProcess(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const code = await waitForTool(killer);
      if (code !== 0 && child.exitCode === null && child.signalCode === null)
        throw new Error(`${taskkill} exited with status ${code}`);
    } else {
      child.kill("SIGKILL");
    }
    await closed;
  })();
  terminations.set(child, termination);
  return termination;
}

export function capturedLauncher(
  command,
  prefix = [],
  {
    baseEnvironment = process.env,
    timeoutMs = 30_000,
    spawnProcess = spawn,
    terminate = terminateProcessTree,
  } = {},
) {
  return (args, options) => {
    const child = spawnProcess(command, [...prefix, ...args], {
      cwd: options.cwd,
      env: { ...baseEnvironment, ...options.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    let timedOut = false;
    let cleanupError;
    let cancelPromise;
    const cancel = () => {
      cancelPromise ??= terminate(child).catch(async (error) => {
        cleanupError = error;
        const closed = waitForClose(child);
        child.kill("SIGKILL");
        await closed;
      });
      return cancelPromise;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void cancel();
    }, timeoutMs);
    const result = new Promise((resolveResult) => {
      child.on("error", (error) => {
        stderr.push(Buffer.from(String(error)));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolveResult({
          status: code ?? (signal ? 128 : 1),
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr:
            Buffer.concat(stderr).toString("utf8") +
            (timedOut ? "\nCLI process exceeded 30 second timeout" : "") +
            (cleanupError ? `\nProcess-tree cleanup failed: ${String(cleanupError)}` : ""),
        });
      });
    });
    result.cancel = cancel;
    result.terminate = (signal = "SIGTERM") => child.kill(signal);
    return result;
  };
}
