import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHttpsDeadlineFetch, isRecord, responseValue } from "./http.js";
import { installMode, type InstallMode } from "./install-mode.js";
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
    latestVersion !== currentVersion &&
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
    `A new version of the Weldall CLI is available (${latestVersion} — you have ${currentVersion}).`,
  ].join("\n");
  const hint =
    mode === "standalone"
      ? "Download the latest release binary from GitHub Releases (https://github.com/seibert-external/weldall/releases) and replace your current binary. The CLI README lists the standalone install steps."
      : "npm install --global @weldall/cli@latest";
  return { message, hint };
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
    const temporary = join(this.directory, `.update-check-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
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
}
