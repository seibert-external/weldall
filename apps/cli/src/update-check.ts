import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHttpsDeadlineFetch, isRecord, responseValue } from "./http.js";
import { installMode, type InstallMode } from "./install-mode.js";
import { atomicWriteFile } from "./storage/atomic-write.js";
import { withLock } from "./storage/lock.js";
import { CONFIG_DIRECTORY } from "./storage/preferences.js";

export const LATEST_VERSION_URL = "https://registry.npmjs.org/@weldall/cli/latest";
export const REGISTRY_TIMEOUT_MS = 2_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_FILENAME = "update-check.json";

export interface UpdateCheckCache {
  lastCheckedEpoch: number;
  lastNotifiedVersion: string | null;
}

export interface UpdateAdvice {
  message: string;
  hint: string;
}

const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function semanticVersionParts(version: string): [string[], string[]] | null {
  const match = SEMANTIC_VERSION.exec(version);
  if (!match) return null;
  return [[match[1]!, match[2]!, match[3]!], match[4]?.split(".") ?? []];
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  return left === right ? 0 : left > right ? 1 : -1;
}

export function isNewerVersion(latestVersion: string, currentVersion: string): boolean {
  const latest = semanticVersionParts(latestVersion);
  const current = semanticVersionParts(currentVersion);
  if (!latest || !current) return false;
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericIdentifiers(latest[0][index]!, current[0][index]!);
    if (comparison !== 0) return comparison > 0;
  }
  if (latest[1].length === 0 || current[1].length === 0)
    return latest[1].length === 0 && current[1].length > 0;
  const length = Math.max(latest[1].length, current[1].length);
  for (let index = 0; index < length; index += 1) {
    const latestPart = latest[1][index];
    const currentPart = current[1][index];
    if (latestPart === currentPart) continue;
    if (latestPart === undefined) return false;
    if (currentPart === undefined) return true;
    const latestNumeric = /^\d+$/.test(latestPart);
    const currentNumeric = /^\d+$/.test(currentPart);
    if (latestNumeric && currentNumeric)
      return compareNumericIdentifiers(latestPart, currentPart) > 0;
    if (latestNumeric !== currentNumeric) return !latestNumeric;
    return latestPart > currentPart;
  }
  return false;
}

export function parseLatestVersion(value: unknown): string | null {
  if (!isRecord(value) || typeof value.version !== "string" || value.version.length === 0)
    return null;
  return value.version;
}

export function shouldCheckNow(cache: UpdateCheckCache | null, nowEpoch: number): boolean {
  if (cache === null) return true;
  if (!Number.isFinite(cache.lastCheckedEpoch) || cache.lastCheckedEpoch <= 0) return true;
  return nowEpoch - cache.lastCheckedEpoch >= CHECK_INTERVAL_MS;
}

export function nextCacheState(
  cache: UpdateCheckCache | null,
  latestVersion: string | null,
  currentVersion: string,
  nowEpoch: number,
): { notify: boolean; cache: UpdateCheckCache } {
  const lastNotifiedVersion = cache?.lastNotifiedVersion ?? null;
  const notify =
    latestVersion !== null &&
    isNewerVersion(latestVersion, currentVersion) &&
    latestVersion !== lastNotifiedVersion;
  return {
    notify,
    cache: {
      lastCheckedEpoch: nowEpoch,
      lastNotifiedVersion: notify ? latestVersion : lastNotifiedVersion,
    },
  };
}

export function updateAdvice(
  latestVersion: string,
  currentVersion: string,
  mode: InstallMode,
): UpdateAdvice {
  const message = [
    "hey there is a new weldall cli update",
    `A new version of the Weldall CLI is available (${latestVersion} - you have ${currentVersion}).`,
  ].join("\n");
  const hint =
    mode === "standalone"
      ? "Download the latest release binary from GitHub Releases (https://github.com/seibert-external/weldall/releases) and replace your current binary. The CLI README lists the standalone install steps."
      : "npm install --global @weldall/cli@latest";
  return { message, hint };
}

export function printUpdateAdvice(
  advice: UpdateAdvice,
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
): void {
  stderr.write(`${advice.message}\n${advice.hint}\n`);
}

export function shouldRunUpdateCheck(argv: string[]): boolean {
  return !argv.some((argument) => argument === "--json" || argument.startsWith("--json="));
}

async function fetchLatestVersion(fetcher: typeof fetch): Promise<string | null> {
  try {
    const response = await fetcher(LATEST_VERSION_URL, {
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok) return null;
    return parseLatestVersion(await responseValue(response));
  } catch {
    return null;
  }
}

export class UpdateCheckStore {
  constructor(private readonly directory = join(homedir(), CONFIG_DIRECTORY)) {}

  async read(): Promise<UpdateCheckCache | null> {
    try {
      const value = JSON.parse(
        await readFile(join(this.directory, UPDATE_CHECK_FILENAME), "utf8"),
      ) as unknown;
      if (!isRecord(value)) return null;
      const lastCheckedEpoch =
        typeof value.lastCheckedEpoch === "number" && Number.isFinite(value.lastCheckedEpoch)
          ? value.lastCheckedEpoch
          : 0;
      const lastNotifiedVersion =
        typeof value.lastNotifiedVersion === "string" && value.lastNotifiedVersion.length > 0
          ? value.lastNotifiedVersion
          : null;
      return { lastCheckedEpoch, lastNotifiedVersion };
    } catch {
      return null;
    }
  }

  async write(cache: UpdateCheckCache): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, UPDATE_CHECK_FILENAME);
    await atomicWriteFile(path, `${JSON.stringify(cache, null, 2)}\n`);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(fn, { path: join(this.directory, "update-check") });
  }
}

export interface UpdateCheckOptions {
  currentVersion: string;
  installMode?: InstallMode;
  nowEpoch?: number;
  fetcher?: typeof fetch;
  store?: UpdateCheckStore;
  stderrIsTty?: boolean;
}

export async function runUpdateCheck(options: UpdateCheckOptions): Promise<UpdateAdvice | null> {
  if ((options.stderrIsTty ?? process.stderr.isTTY) !== true) return null;
  const nowEpoch = options.nowEpoch ?? Date.now();
  const mode = options.installMode ?? installMode;
  const store = options.store ?? new UpdateCheckStore();
  const fetcher = options.fetcher ?? createHttpsDeadlineFetch(REGISTRY_TIMEOUT_MS);

  try {
    return await store.transaction(async () => {
      const cache = await store.read().catch(() => null);
      if (!shouldCheckNow(cache, nowEpoch)) return null;

      const latestVersion = await fetchLatestVersion(fetcher);
      const { notify, cache: nextCache } = nextCacheState(
        cache,
        latestVersion,
        options.currentVersion,
        nowEpoch,
      );
      if (!notify || latestVersion === null) {
        await store.write(nextCache).catch(() => undefined);
        return null;
      }
      try {
        await store.write(nextCache);
      } catch {
        return null;
      }
      return updateAdvice(latestVersion, options.currentVersion, mode);
    });
  } catch {
    return null;
  }
}
