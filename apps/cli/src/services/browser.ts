import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CliError } from "../errors.js";

export type BrowserOpener = (url: string) => Promise<void>;
export type BrowserCommandRunner = (executable: string, args: string[]) => Promise<void>;

type BrowserExecFile = (
  executable: string,
  args: string[],
  options: { timeout: number; killSignal: NodeJS.Signals; windowsHide: boolean },
  callback: (error: Error | null) => void,
) => unknown;

export const browserOpenTimeoutMs = 10_000;

export const runBrowserCommand = (
  executable: string,
  args: string[],
  execute: BrowserExecFile = execFile,
): Promise<void> =>
  new Promise((resolve, reject) => {
    execute(
      executable,
      args,
      { timeout: browserOpenTimeoutMs, killSignal: "SIGTERM", windowsHide: true },
      (error) => (error ? reject(error) : resolve()),
    );
  });

const browserCommand = (platform: NodeJS.Platform, url: string): [string, string[]] => {
  switch (platform) {
    case "darwin":
      return ["open", [url]];
    case "linux":
      return ["xdg-open", [url]];
    case "win32":
      return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
    default:
      throw new CliError(`Opening a browser is not supported on ${platform}`, {
        hint: "Use the CLI on macOS, Linux, or Windows.",
      });
  }
};

const writeBrowserUrl = async (path: string, url: string) => {
  const temporary = join(dirname(path), `.weldall-browser-${randomUUID()}.tmp`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, url, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

export function createBrowserOpener(
  options: {
    platform?: NodeJS.Platform;
    runner?: BrowserCommandRunner;
    e2eUrlFile?: string;
    nodeEnv?: string;
  } = {},
): BrowserOpener {
  const e2eUrlFile = options.e2eUrlFile;
  const nodeEnv = options.nodeEnv;
  if (e2eUrlFile && nodeEnv !== "test")
    throw new CliError("WELDALL_E2E_BROWSER_URL_FILE is only allowed when NODE_ENV=test");
  if (e2eUrlFile) return (url) => writeBrowserUrl(e2eUrlFile, url);

  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runBrowserCommand;
  return async (url) => {
    const [executable, args] = browserCommand(platform, url);
    await runner(executable, args);
  };
}

// Resolve guarded seams when the command runs so bundlers cannot capture the
// build process environment in the exported default opener.
export const browserOpener: BrowserOpener = (url) => {
  const e2eUrlFile = process.env["WELDALL_E2E_BROWSER_URL_FILE"];
  const nodeEnv = process.env["NODE_ENV"];
  return createBrowserOpener({
    ...(e2eUrlFile === undefined ? {} : { e2eUrlFile }),
    ...(nodeEnv === undefined ? {} : { nodeEnv }),
  })(url);
};
