import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  rename as nodeRename,
  rm as nodeRm,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { ConfigurationError } from "../errors.js";

export const PREFERENCES_DOMAIN = "dev.seibert.weldall-cli";
export const ISSUER_PREFERENCE = "Issuer";
export const CONFIG_DIRECTORY = ".weldall";
export const CONFIG_FILENAME = "config.json";

export type RunDefaults = (args: string[]) => Promise<string>;

const runDefaults: RunDefaults = (args) =>
  new Promise((resolve, reject) => {
    execFile("/usr/bin/defaults", args, { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

export interface IssuerPreferences {
  read(): Promise<string | null>;
  write(issuer: string): Promise<void>;
  clear(): Promise<void>;
}

const canonicalIssuer = (issuer: string): string => {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch (error) {
    throw new ConfigurationError("The Weldall issuer preference must be a canonical HTTPS origin", {
      cause: error,
      hint: "Use a URL such as https://weldall.example.com without a path.",
    });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    issuer !== url.origin
  )
    throw new ConfigurationError("The Weldall issuer preference must be a canonical HTTPS origin", {
      hint: "Use a URL such as https://weldall.example.com without a path.",
    });
  return issuer;
};

export class MacIssuerPreferences implements IssuerPreferences {
  constructor(private readonly run: RunDefaults = runDefaults) {}

  async read() {
    try {
      const value = (await this.run(["read", PREFERENCES_DOMAIN, ISSUER_PREFERENCE])).trim();
      return value || null;
    } catch (error) {
      if ((error as { code?: string | number }).code === 1) return null;
      throw new ConfigurationError("Unable to read the Weldall issuer preference", {
        cause: error,
        hint: "Check access to macOS Preferences or set WELDALL_ISSUER.",
      });
    }
  }

  async write(issuer: string) {
    canonicalIssuer(issuer);
    try {
      await this.run(["write", PREFERENCES_DOMAIN, ISSUER_PREFERENCE, "-string", issuer]);
    } catch (error) {
      throw new ConfigurationError("Unable to save the Weldall issuer preference", {
        cause: error,
        hint: "Check access to macOS Preferences or set WELDALL_ISSUER.",
      });
    }
  }

  async clear() {
    try {
      await this.run(["delete", PREFERENCES_DOMAIN, ISSUER_PREFERENCE]);
    } catch (error) {
      if ((error as { code?: string | number }).code !== 1)
        throw new ConfigurationError("Unable to clear the Weldall issuer preference", {
          cause: error,
          hint: "Check access to macOS Preferences.",
        });
    }
  }
}

export interface PreferencesFileSystem {
  readFile(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  writeFile(path: string, value: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
}

const preferencesFileSystem: PreferencesFileSystem = {
  readFile: (path) => nodeReadFile(path, "utf8"),
  mkdir: async (path) => {
    await nodeMkdir(path, { recursive: true, mode: 0o700 });
  },
  writeFile: async (path, value) => {
    await nodeWriteFile(path, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
  },
  rename: nodeRename,
  rm: async (path) => {
    await nodeRm(path, { force: true });
  },
};

export class FileIssuerPreferences implements IssuerPreferences {
  constructor(
    readonly path: string,
    private readonly files: PreferencesFileSystem = preferencesFileSystem,
  ) {}

  async read() {
    let raw: string;
    try {
      raw = await this.files.readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ConfigurationError(`Unable to read the Weldall issuer config at ${this.path}`, {
        cause: error,
      });
    }

    try {
      const value = JSON.parse(raw) as unknown;
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        typeof (value as { issuer?: unknown }).issuer !== "string"
      )
        throw new Error("expected an object with an issuer string");
      return canonicalIssuer((value as { issuer: string }).issuer);
    } catch (error) {
      throw new ConfigurationError(
        `The Weldall issuer config at ${this.path} is corrupt or invalid`,
        {
          cause: error,
          hint: "Run `weldall config reset-issuer`, then set the issuer again.",
        },
      );
    }
  }

  async write(issuer: string) {
    canonicalIssuer(issuer);
    const directory = dirname(this.path);
    const temporary = join(directory, `.weldall-config-${randomUUID()}.tmp`);
    try {
      await this.files.mkdir(directory);
      await this.files.writeFile(temporary, `${JSON.stringify({ issuer }, null, 2)}\n`);
      await this.files.rename(temporary, this.path);
    } catch (error) {
      throw new ConfigurationError(`Unable to save the Weldall issuer config at ${this.path}`, {
        cause: error,
        hint: "Check that your user configuration directory is writable.",
      });
    } finally {
      await this.files.rm(temporary).catch(() => undefined);
    }
  }

  async clear() {
    try {
      await this.files.rm(this.path);
    } catch (error) {
      throw new ConfigurationError(`Unable to clear the Weldall issuer config at ${this.path}`, {
        cause: error,
        hint: "Check that your user configuration directory is writable.",
      });
    }
  }
}

export interface IssuerPreferenceProviders {
  macos(run: RunDefaults): IssuerPreferences;
  file(path: string, files?: PreferencesFileSystem): IssuerPreferences;
}

const issuerPreferenceProviders: IssuerPreferenceProviders = {
  macos: (run) => new MacIssuerPreferences(run),
  file: (path, files) => new FileIssuerPreferences(path, files),
};

export function issuerConfigPath(homeDirectory = homedir()) {
  return join(homeDirectory, CONFIG_DIRECTORY, CONFIG_FILENAME);
}

export function createIssuerPreferences(
  options: {
    platform?: NodeJS.Platform;
    homeDirectory?: string;
    runDefaults?: RunDefaults;
    files?: PreferencesFileSystem;
    providers?: IssuerPreferenceProviders;
  } = {},
): IssuerPreferences {
  const platform = options.platform ?? process.platform;
  const providers = options.providers ?? issuerPreferenceProviders;
  if (platform === "darwin") return providers.macos(options.runDefaults ?? runDefaults);
  if (platform === "linux" || platform === "win32")
    return providers.file(
      issuerConfigPath(options.homeDirectory ?? homedir()),
      options.files ?? preferencesFileSystem,
    );
  throw new ConfigurationError(`Persistent issuer preferences are not supported on ${platform}`, {
    hint: "Set WELDALL_ISSUER or use the CLI on macOS, Linux, or Windows.",
  });
}

const runtimeEnvironmentValue = (name: string) => process.env[name];
const testPreferencesFile = runtimeEnvironmentValue("WELDALL_TEST_PREFERENCES_FILE");
if (testPreferencesFile && runtimeEnvironmentValue("NODE_ENV") !== "test")
  throw new ConfigurationError("WELDALL_TEST_PREFERENCES_FILE is only allowed when NODE_ENV=test");
if (testPreferencesFile && !isAbsolute(testPreferencesFile))
  throw new ConfigurationError("WELDALL_TEST_PREFERENCES_FILE must be an absolute path");

export const issuerPreferences = testPreferencesFile
  ? new FileIssuerPreferences(testPreferencesFile)
  : createIssuerPreferences();
