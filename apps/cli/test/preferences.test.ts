import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIG_DIRECTORY,
  CONFIG_FILENAME,
  FileIssuerPreferences,
  ISSUER_PREFERENCE,
  MacIssuerPreferences,
  PREFERENCES_DOMAIN,
  createIssuerPreferences,
  issuerConfigPath,
  type IssuerPreferenceProviders,
  type IssuerPreferences,
  type PreferencesFileSystem,
} from "../src/storage/preferences.js";

const issuer = "https://weldall.example.com";
const emptyPreferences: IssuerPreferences = {
  read: async () => null,
  write: async () => undefined,
  clear: async () => undefined,
};

const temporaryHome = async () => mkdtemp(join(tmpdir(), "weldall preferences ünicode "));

afterEach(() => vi.restoreAllMocks());

describe("issuer preference factory", () => {
  it("selects macOS defaults and Linux/Windows file providers", () => {
    const macos = vi.fn(() => emptyPreferences);
    const file = vi.fn(() => emptyPreferences);
    const providers: IssuerPreferenceProviders = { macos, file };
    const runDefaults = vi.fn(async () => "");

    expect(createIssuerPreferences({ platform: "darwin", providers, runDefaults })).toBe(
      emptyPreferences,
    );
    expect(macos).toHaveBeenCalledWith(runDefaults);

    for (const platform of ["linux", "win32"] as const) {
      expect(
        createIssuerPreferences({ platform, providers, homeDirectory: "/home/Test User" }),
      ).toBe(emptyPreferences);
    }
    expect(file).toHaveBeenNthCalledWith(
      1,
      join("/home/Test User", CONFIG_DIRECTORY, CONFIG_FILENAME),
      expect.any(Object),
    );
    expect(file).toHaveBeenNthCalledWith(
      2,
      join("/home/Test User", CONFIG_DIRECTORY, CONFIG_FILENAME),
      expect.any(Object),
    );
  });

  it("fails clearly on unsupported platforms", () => {
    expect(() => createIssuerPreferences({ platform: "aix" })).toThrow(
      "Persistent issuer preferences are not supported",
    );
  });
});

describe("macOS issuer preferences", () => {
  it("preserves the defaults domain, key, and argv compatibility", async () => {
    const run = vi
      .fn<(args: string[]) => Promise<string>>()
      .mockResolvedValueOnce(`${issuer}\n`)
      .mockResolvedValue("");
    const preferences = new MacIssuerPreferences(run);

    await expect(preferences.read()).resolves.toBe(issuer);
    await preferences.write(issuer);
    await preferences.clear();

    expect(run.mock.calls).toEqual([
      [["read", PREFERENCES_DOMAIN, ISSUER_PREFERENCE]],
      [["write", PREFERENCES_DOMAIN, ISSUER_PREFERENCE, "-string", issuer]],
      [["delete", PREFERENCES_DOMAIN, ISSUER_PREFERENCE]],
    ]);
  });

  it("treats a missing defaults value as null and validates before writing", async () => {
    const missing = Object.assign(new Error("missing"), { code: 1 });
    const run = vi.fn<(args: string[]) => Promise<string>>().mockRejectedValue(missing);
    const preferences = new MacIssuerPreferences(run);

    await expect(preferences.read()).resolves.toBeNull();
    await expect(preferences.clear()).resolves.toBeUndefined();
    await expect(preferences.write(`${issuer}/path`)).rejects.toThrow("canonical HTTPS origin");
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("file issuer preferences", () => {
  it("reads, writes, replaces, and clears config under a Unicode home path", async () => {
    const home = await temporaryHome();
    const path = issuerConfigPath(home);
    const preferences = new FileIssuerPreferences(path);
    try {
      await expect(preferences.read()).resolves.toBeNull();
      await preferences.write(issuer);
      await expect(preferences.read()).resolves.toBe(issuer);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ issuer });
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);

      const replacement = "https://replacement.example.com";
      await preferences.write(replacement);
      await expect(preferences.read()).resolves.toBe(replacement);
      expect((await readdir(join(home, CONFIG_DIRECTORY))).sort()).toEqual([CONFIG_FILENAME]);

      await preferences.clear();
      await expect(preferences.read()).resolves.toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["corrupt JSON", "{"],
    ["wrong shape", JSON.stringify({ issuer: 1 })],
    ["noncanonical issuer", JSON.stringify({ issuer: `${issuer}/` })],
    ["insecure issuer", JSON.stringify({ issuer: "http://weldall.example.com" })],
  ])("fails clearly for %s", async (_name, contents) => {
    const files: PreferencesFileSystem = {
      readFile: async () => contents,
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      rename: async () => undefined,
      rm: async () => undefined,
    };
    await expect(new FileIssuerPreferences("config.json", files).read()).rejects.toThrow(
      "corrupt or invalid",
    );
  });

  it("strictly validates canonical HTTPS origins before creating files", async () => {
    const files: PreferencesFileSystem = {
      readFile: async () => "",
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
    };
    const preferences = new FileIssuerPreferences("config.json", files);

    for (const invalid of [
      "weldall.example.com",
      `${issuer}/`,
      `${issuer}/path`,
      `${issuer}?query=1`,
      "http://weldall.example.com",
      "https://user@example.com",
    ])
      await expect(preferences.write(invalid)).rejects.toThrow("canonical HTTPS origin");
    expect(files.mkdir).not.toHaveBeenCalled();
  });

  it("preserves an existing real config and removes temp debris when replacement fails", async () => {
    const home = await temporaryHome();
    const path = issuerConfigPath(home);
    const preferences = new FileIssuerPreferences(path);
    try {
      await preferences.write(issuer);
      const original = await readFile(path, "utf8");
      const files: PreferencesFileSystem = {
        readFile: (filePath) => readFile(filePath, "utf8"),
        mkdir: async (directory) => {
          await mkdir(directory, { recursive: true, mode: 0o700 });
        },
        writeFile: async (filePath, value) => {
          await writeFile(filePath, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
        },
        rename: async () => {
          throw new Error("injected replacement failure");
        },
        rm: async (filePath) => {
          await rm(filePath, { force: true });
        },
      };

      await expect(
        new FileIssuerPreferences(path, files).write("https://replacement.example.com"),
      ).rejects.toThrow("Unable to save");
      expect(await readFile(path, "utf8")).toBe(original);
      await expect(preferences.read()).resolves.toBe(issuer);
      expect(await readdir(join(home, CONFIG_DIRECTORY))).toEqual([CONFIG_FILENAME]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("renames a same-directory temporary file and guards cleanup on replacement failure", async () => {
    const calls: string[] = [];
    const files: PreferencesFileSystem = {
      readFile: async () => "",
      mkdir: async (path) => {
        calls.push(`mkdir:${path}`);
      },
      writeFile: async (path) => {
        calls.push(`write:${path}`);
      },
      rename: async (from, to) => {
        calls.push(`rename:${from}:${to}`);
        throw new Error("replace failed");
      },
      rm: async (path) => {
        calls.push(`rm:${path}`);
      },
    };
    const path = join("home", ".weldall", "config.json");

    await expect(new FileIssuerPreferences(path, files).write(issuer)).rejects.toThrow(
      "Unable to save",
    );
    const writePath = calls.find((call) => call.startsWith("write:"))?.slice("write:".length);
    expect(writePath).toMatch(/^home[/\\]\.weldall[/\\]\.weldall-config-.+\.tmp$/);
    expect(calls).toContain(`rename:${writePath}:${path}`);
    expect(calls.at(-1)).toBe(`rm:${writePath}`);
  });
});
