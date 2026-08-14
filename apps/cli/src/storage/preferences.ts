import { execFile } from "node:child_process";
import { ConfigurationError } from "../errors.js";

export const PREFERENCES_DOMAIN = "dev.seibert.weldall-cli";
export const ISSUER_PREFERENCE = "Issuer";

type RunDefaults = (args: string[]) => Promise<string>;

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

export class MacIssuerPreferences implements IssuerPreferences {
  constructor(private readonly run: RunDefaults = runDefaults) {}

  private assertSupported() {
    if (process.platform !== "darwin" && process.env.NODE_ENV !== "test")
      throw new ConfigurationError("Persistent issuer preferences require macOS", {
        hint: "Set WELDALL_ISSUER for IaC commands on another OS.",
      });
  }

  async read() {
    this.assertSupported();
    try {
      const value = (await this.run(["read", PREFERENCES_DOMAIN, ISSUER_PREFERENCE])).trim();
      return value || null;
    } catch (error) {
      if ((error as { code?: string | number }).code === 1) return null;
      throw new ConfigurationError("Unable to read the Weldall macOS preference", { cause: error });
    }
  }

  async write(issuer: string) {
    this.assertSupported();
    try {
      await this.run(["write", PREFERENCES_DOMAIN, ISSUER_PREFERENCE, "-string", issuer]);
    } catch (error) {
      throw new ConfigurationError("Unable to save the Weldall issuer", { cause: error });
    }
  }

  async clear() {
    this.assertSupported();
    try {
      await this.run(["delete", PREFERENCES_DOMAIN, ISSUER_PREFERENCE]);
    } catch (error) {
      if ((error as { code?: string | number }).code !== 1)
        throw new ConfigurationError("Unable to clear the Weldall issuer", { cause: error });
    }
  }
}

export const issuerPreferences = new MacIssuerPreferences();
