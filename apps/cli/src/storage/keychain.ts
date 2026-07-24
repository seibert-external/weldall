import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JWK } from "jose";
import { CliError } from "../errors.js";

const SERVICE = "dev.seibert.weldall-cli";
const CREDENTIALS_VERSION = 1;
const testCredentialsFile = process.env.WELDALL_E2E_CREDENTIALS_FILE;

if (testCredentialsFile && process.env.NODE_ENV !== "test")
  throw new CliError("WELDALL_E2E_CREDENTIALS_FILE is only allowed when NODE_ENV=test");

export interface StoredCredentials {
  version: typeof CREDENTIALS_VERSION;
  issuer: string;
  privateJwk: JWK;
  publicJwk: JWK;
  refreshToken: string;
}

type TestKeychain = Record<string, StoredCredentials>;

const accountFor = (issuer: string) =>
  `session-${createHash("sha256").update(issuer).digest("base64url")}`;

const parseCredentials = (raw: string, issuer: string): StoredCredentials => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new CliError("The stored Weldall session is corrupted", {
      cause: error,
      hint: "Run `weldall logout` and log in again.",
    });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Partial<StoredCredentials>).version !== CREDENTIALS_VERSION ||
    (value as Partial<StoredCredentials>).issuer !== issuer ||
    typeof (value as Partial<StoredCredentials>).refreshToken !== "string" ||
    !(value as Partial<StoredCredentials>).refreshToken ||
    typeof (value as Partial<StoredCredentials>).privateJwk !== "object" ||
    typeof (value as Partial<StoredCredentials>).publicJwk !== "object"
  )
    throw new CliError("The stored Weldall session has an unsupported format", {
      hint: "Run `weldall logout` and log in again.",
    });
  return value as StoredCredentials;
};

const readTestKeychain = (): TestKeychain => {
  if (!testCredentialsFile) return {};
  try {
    const value = JSON.parse(readFileSync(testCredentialsFile, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("invalid test keychain");
    return value as TestKeychain;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
};

const writeTestKeychain = (value: TestKeychain) => {
  if (!testCredentialsFile) return;
  const temporary = join(dirname(testCredentialsFile), `.weldall-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temporary, testCredentialsFile);
};

const nativeEntry = async (issuer: string) => {
  const { Entry } = await import("@napi-rs/keyring");
  return new Entry(SERVICE, accountFor(issuer));
};

export const keychain = {
  async get(issuer: string): Promise<StoredCredentials | null> {
    const account = accountFor(issuer);
    if (testCredentialsFile) {
      const stored = readTestKeychain()[account];
      return stored ? parseCredentials(JSON.stringify(stored), issuer) : null;
    }

    let raw: string | null;
    try {
      raw = (await nativeEntry(issuer)).getPassword();
    } catch (error) {
      throw new CliError("Unable to read the Weldall session from Keychain", { cause: error });
    }
    return raw ? parseCredentials(raw, issuer) : null;
  },

  async set(issuer: string, credentials: Omit<StoredCredentials, "issuer" | "version">) {
    const stored: StoredCredentials = {
      version: CREDENTIALS_VERSION,
      issuer,
      ...credentials,
    };
    if (testCredentialsFile) {
      const value = readTestKeychain();
      value[accountFor(issuer)] = stored;
      writeTestKeychain(value);
      return;
    }
    try {
      (await nativeEntry(issuer)).setPassword(JSON.stringify(stored));
    } catch (error) {
      throw new CliError("Unable to save the Weldall session in Keychain", { cause: error });
    }
  },

  async clear(issuer: string) {
    const account = accountFor(issuer);
    if (testCredentialsFile) {
      const value = readTestKeychain();
      delete value[account];
      if (Object.keys(value).length === 0) rmSync(testCredentialsFile, { force: true });
      else writeTestKeychain(value);
      return;
    }
    try {
      (await nativeEntry(issuer)).deletePassword();
    } catch (error) {
      throw new CliError("Unable to remove the Weldall session from Keychain", { cause: error });
    }
  },
};
