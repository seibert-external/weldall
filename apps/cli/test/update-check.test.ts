import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installMode } from "../src/install-mode.js";
import {
  CHECK_INTERVAL_MS,
  LATEST_VERSION_URL,
  UPDATE_CHECK_FILENAME,
  UpdateCheckStore,
  isNewerVersion,
  nextCacheState,
  parseLatestVersion,
  printUpdateAdvice,
  runUpdateCheck,
  shouldCheckNow,
  shouldRunUpdateCheck,
  updateAdvice,
  type UpdateCheckCache,
} from "../src/update-check.js";

const jsonResponse = (body: unknown, ok = true): Response =>
  new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });

const temporaryStore = async () => {
  const home = await mkdtemp(join(tmpdir(), "weldall update check "));
  return { home, store: new UpdateCheckStore(home) };
};

describe("parseLatestVersion", () => {
  it("extracts a registry version from a JSON object", () => {
    expect(parseLatestVersion({ version: "1.2.3" })).toBe("1.2.3");
  });

  it("rejects non-object, missing, or non-string versions", () => {
    for (const value of [null, undefined, [], "1.2.3", { version: 1 }, { version: "" }, {}])
      expect(parseLatestVersion(value)).toBeNull();
  });
});

describe("install mode constant", () => {
  it("defaults to npm for typecheck, dev, and test runs", () => {
    expect(installMode).toBe("npm");
  });
});

describe("updateAdvice", () => {
  it("leads with the exact notice line and includes version context", () => {
    const advice = updateAdvice("2.1.0", "1.0.0", "npm");
    expect(advice.message.split("\n")[0]).toBe("hey there is a new weldall cli update");
    expect(advice.message).toContain(
      "A new version of the Weldall CLI is available (2.1.0 — you have 1.0.0).",
    );
  });

  it("advises the npm global install command for npm installs", () => {
    expect(updateAdvice("2.1.0", "1.0.0", "npm").hint).toBe(
      "npm install --global @weldall/cli@latest",
    );
  });

  it("advises replacing the binary from GitHub Releases for standalone installs", () => {
    const advice = updateAdvice("2.1.0", "1.0.0", "standalone");
    expect(advice.hint).toContain("https://github.com/seibert-external/weldall/releases");
    expect(advice.hint).toContain("replace your current binary");
    expect(advice.hint).not.toContain("npm install");
  });
});

describe("shouldCheckNow", () => {
  it("checks when there is no cache yet", () => {
    expect(shouldCheckNow(null, 1_000)).toBe(true);
  });

  it("skips a check within the daily interval", () => {
    const cache: UpdateCheckCache = { lastCheckedEpoch: 1_000 - 1, lastNotifiedVersion: null };
    expect(shouldCheckNow(cache, 1_000)).toBe(false);
  });

  it("checks again once the daily interval has passed", () => {
    const cache: UpdateCheckCache = {
      lastCheckedEpoch: 1_000 - CHECK_INTERVAL_MS,
      lastNotifiedVersion: null,
    };
    expect(shouldCheckNow(cache, 1_000)).toBe(true);
  });

  it("checks again when the cache is invalid", () => {
    expect(shouldCheckNow({ lastCheckedEpoch: 0, lastNotifiedVersion: null }, 1_000)).toBe(true);
  });
});

describe("nextCacheState", () => {
  it("notifies once for a new version and records it", () => {
    const { notify, cache } = nextCacheState(null, "2.0.0", "1.0.0", 1_000);
    expect(notify).toBe(true);
    expect(cache).toEqual({ lastCheckedEpoch: 1_000, lastNotifiedVersion: "2.0.0" });
  });

  it("does not notify when already on the latest version but still caches the check", () => {
    const { notify, cache } = nextCacheState(null, "1.0.0", "1.0.0", 1_000);
    expect(notify).toBe(false);
    expect(cache).toEqual({ lastCheckedEpoch: 1_000, lastNotifiedVersion: null });
  });

  it("does not notify for an older or invalid registry version", () => {
    expect(nextCacheState(null, "0.9.0", "1.0.0", 1_000).notify).toBe(false);
    expect(nextCacheState(null, "not-semver", "1.0.0", 1_000).notify).toBe(false);
  });

  it("dedupes by the already notified version", () => {
    const cache: UpdateCheckCache = { lastCheckedEpoch: 0, lastNotifiedVersion: "2.0.0" };
    const { notify } = nextCacheState(cache, "2.0.0", "1.0.0", 1_000);
    expect(notify).toBe(false);
  });

  it("notifies again for a newer version than the notified one", () => {
    const cache: UpdateCheckCache = { lastCheckedEpoch: 0, lastNotifiedVersion: "2.0.0" };
    const { notify, cache: next } = nextCacheState(cache, "3.0.0", "1.0.0", 1_000);
    expect(notify).toBe(true);
    expect(next.lastNotifiedVersion).toBe("3.0.0");
  });
});

describe("semantic version ordering", () => {
  it("orders stable and prerelease versions using semantic-version precedence", () => {
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isNewerVersion("1.0.0-rc.2", "1.0.0-rc.1")).toBe(true);
    expect(isNewerVersion("1.0.0-rc.1", "1.0.0-rc")).toBe(true);
    expect(isNewerVersion("1.0.0-rc", "1.0.0-rc.1")).toBe(false);
    expect(isNewerVersion("1.0.0-rc.1", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0+new", "1.0.0+old")).toBe(false);
    expect(isNewerVersion("9007199254740993.0.0", "9007199254740992.0.0")).toBe(true);
    expect(
      isNewerVersion("1.0.0-9007199254740993", "1.0.0-9007199254740992"),
    ).toBe(true);
  });
});

describe("printUpdateAdvice", () => {
  it("writes the exact lead line first and writes only to the supplied stderr", () => {
    const write = vi.fn();
    printUpdateAdvice(updateAdvice("2.0.0", "1.0.0", "npm"), { write });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![0].split("\n")[0]).toBe(
      "hey there is a new weldall cli update",
    );
  });
});

describe("shouldRunUpdateCheck", () => {
  it("suppresses checks for every JSON argument form", () => {
    expect(shouldRunUpdateCheck(["status", "--json"])).toBe(false);
    expect(shouldRunUpdateCheck(["request", "--json={}"])).toBe(false);
    expect(shouldRunUpdateCheck(["status"])).toBe(true);
  });
});

describe("UpdateCheckStore", () => {
  it("round-trips the sidecar cache in the config directory", async () => {
    const { home, store } = await temporaryStore();
    try {
      await expect(store.read()).resolves.toBeNull();
      await store.write({ lastCheckedEpoch: 1_000, lastNotifiedVersion: "2.0.0" });
      await expect(store.read()).resolves.toEqual({
        lastCheckedEpoch: 1_000,
        lastNotifiedVersion: "2.0.0",
      });
      expect(JSON.parse(await readFile(join(home, UPDATE_CHECK_FILENAME), "utf8"))).toEqual({
        lastCheckedEpoch: 1_000,
        lastNotifiedVersion: "2.0.0",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("ignores a corrupt or missing cache", async () => {
    const { home, store } = await temporaryStore();
    try {
      await writeFile(join(home, UPDATE_CHECK_FILENAME), "{ not json", "utf8");
      await expect(store.read()).resolves.toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("runUpdateCheck", () => {
  it("skips everything when stderr is not a terminal", async () => {
    const { home, store } = await temporaryStore();
    try {
      const fetcher = vi.fn(async () => jsonResponse({ version: "2.0.0" }));
      const advice = await runUpdateCheck({
        currentVersion: "1.0.0",
        store,
        fetcher,
        stderrIsTty: false,
        nowEpoch: 1_000,
      });
      expect(advice).toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("fails silent on a network error and still caches the check time", async () => {
    const { home, store } = await temporaryStore();
    try {
      const fetcher = vi.fn(async () => {
        throw new Error("network unreachable");
      });
      const advice = await runUpdateCheck({
        currentVersion: "1.0.0",
        store,
        fetcher,
        stderrIsTty: true,
        nowEpoch: 1_000,
      });
      expect(advice).toBeNull();
      await expect(store.read()).resolves.toEqual({
        lastCheckedEpoch: 1_000,
        lastNotifiedVersion: null,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("fails silent on a non-OK registry response", async () => {
    const { home, store } = await temporaryStore();
    try {
      const fetcher = vi.fn(async () => new Response("boom", { status: 503 }));
      await expect(
        runUpdateCheck({
          currentVersion: "1.0.0",
          store,
          fetcher,
          stderrIsTty: true,
          nowEpoch: 1_000,
        }),
      ).resolves.toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("fails silent on an invalid registry body", async () => {
    const { home, store } = await temporaryStore();
    try {
      const fetcher = vi.fn(async () => new Response("not json", { status: 200 }));
      await expect(
        runUpdateCheck({
          currentVersion: "1.0.0",
          store,
          fetcher,
          stderrIsTty: true,
          nowEpoch: 1_000,
        }),
      ).resolves.toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("queries the npm registry and returns npm advice on an interactive terminal", async () => {
    const { home, store } = await temporaryStore();
    try {
      const fetcher = vi.fn(async () => jsonResponse({ version: "2.0.0" }));
      const advice = await runUpdateCheck({
        currentVersion: "1.0.0",
        store,
        fetcher,
        stderrIsTty: true,
        nowEpoch: 1_000,
      });
      expect(fetcher).toHaveBeenCalledWith(
        LATEST_VERSION_URL,
        expect.objectContaining({ headers: { accept: "application/json" } }),
      );
      expect(advice?.message.split("\n")[0]).toBe("hey there is a new weldall cli update");
      expect(advice?.hint).toBe("npm install --global @weldall/cli@latest");
      await expect(store.read()).resolves.toEqual({
        lastCheckedEpoch: 1_000,
        lastNotifiedVersion: "2.0.0",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("returns standalone advice when built as a standalone binary", async () => {
    const { home, store } = await temporaryStore();
    try {
      const fetcher = vi.fn(async () => jsonResponse({ version: "2.0.0" }));
      const advice = await runUpdateCheck({
        currentVersion: "1.0.0",
        store,
        fetcher,
        installMode: "standalone",
        stderrIsTty: true,
        nowEpoch: 1_000,
      });
      expect(advice?.hint).toContain("https://github.com/seibert-external/weldall/releases");
      expect(advice?.hint).not.toContain("npm install");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("is silent for users on the newest version but still caches the check", async () => {
    const { home, store } = await temporaryStore();
    try {
      const fetcher = vi.fn(async () => jsonResponse({ version: "1.0.0" }));
      const advice = await runUpdateCheck({
        currentVersion: "1.0.0",
        store,
        fetcher,
        stderrIsTty: true,
        nowEpoch: 1_000,
      });
      expect(advice).toBeNull();
      await expect(store.read()).resolves.toEqual({
        lastCheckedEpoch: 1_000,
        lastNotifiedVersion: null,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("dedupes the note per notified version across daily checks", async () => {
    const { home, store } = await temporaryStore();
    try {
      const fetcher = vi.fn(async () => jsonResponse({ version: "2.0.0" }));
      const first = await runUpdateCheck({
        currentVersion: "1.0.0",
        store,
        fetcher,
        stderrIsTty: true,
        nowEpoch: 1_000,
      });
      expect(first?.hint).toBe("npm install --global @weldall/cli@latest");

      const second = await runUpdateCheck({
        currentVersion: "1.0.0",
        store,
        fetcher,
        stderrIsTty: true,
        nowEpoch: 1_000 + CHECK_INTERVAL_MS,
      });
      expect(second).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(2);
      await expect(store.read()).resolves.toEqual({
        lastCheckedEpoch: 1_000 + CHECK_INTERVAL_MS,
        lastNotifiedVersion: "2.0.0",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("allows only one concurrent invocation to check and notify", async () => {
    const { home, store } = await temporaryStore();
    try {
      const fetcher = vi.fn(async () => jsonResponse({ version: "2.0.0" }));
      const options = {
        currentVersion: "1.0.0",
        store,
        fetcher,
        stderrIsTty: true,
        nowEpoch: 1_000,
      };
      const results = await Promise.all([runUpdateCheck(options), runUpdateCheck(options)]);
      expect(results.filter((result) => result !== null)).toHaveLength(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("notifies again when a newer version appears after a prior notification", async () => {
    const { home, store } = await temporaryStore();
    try {
      let latest = "2.0.0";
      const fetcher = vi.fn(async () => jsonResponse({ version: latest }));
      await runUpdateCheck({
        currentVersion: "1.0.0",
        store,
        fetcher,
        stderrIsTty: true,
        nowEpoch: 1_000,
      });
      latest = "3.0.0";
      const second = await runUpdateCheck({
        currentVersion: "1.0.0",
        store,
        fetcher,
        stderrIsTty: true,
        nowEpoch: 1_000 + CHECK_INTERVAL_MS,
      });
      expect(second?.message).toContain("(3.0.0 — you have 1.0.0)");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("skips the network entirely when a check already ran today", async () => {
    const { home, store } = await temporaryStore();
    try {
      const fetcher = vi.fn(async () => jsonResponse({ version: "2.0.0" }));
      await runUpdateCheck({
        currentVersion: "1.0.0",
        store,
        fetcher,
        stderrIsTty: true,
        nowEpoch: 1_000,
      });
      const again = await runUpdateCheck({
        currentVersion: "1.0.0",
        store,
        fetcher,
        stderrIsTty: true,
        nowEpoch: 1_000 + 1,
      });
      expect(again).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
