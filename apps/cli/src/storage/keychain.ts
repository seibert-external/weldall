import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JWK } from "jose";
import { CliError } from "../errors.js";

const SERVICE = "dev.seibert.weldall-cli";
const CREDENTIALS_VERSION = 1;
// Bracketed runtime lookup prevents standalone compilation from folding test-only environment seams.
const runtimeEnvironmentValue = (name: string) => process.env[name];
const testCredentialsFile = runtimeEnvironmentValue("WELDALL_E2E_CREDENTIALS_FILE");

if (testCredentialsFile && runtimeEnvironmentValue("NODE_ENV") !== "test")
  throw new CliError("WELDALL_E2E_CREDENTIALS_FILE is only allowed when NODE_ENV=test");

export interface StoredIdentity {
  subject?: string;
  name: string;
  email: string;
}

export interface StoredCredentials {
  version: typeof CREDENTIALS_VERSION;
  issuer: string;
  privateJwk: JWK;
  publicJwk: JWK;
  refreshToken: string;
  identity?: StoredIdentity;
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
    typeof (value as Partial<StoredCredentials>).publicJwk !== "object" ||
    ((value as Partial<StoredCredentials>).identity !== undefined &&
      (typeof (value as Partial<StoredCredentials>).identity !== "object" ||
        ((value as Partial<StoredCredentials>).identity?.subject !== undefined &&
          (typeof (value as Partial<StoredCredentials>).identity?.subject !== "string" ||
            !(value as Partial<StoredCredentials>).identity?.subject?.trim())) ||
        typeof (value as Partial<StoredCredentials>).identity?.name !== "string" ||
        !(value as Partial<StoredCredentials>).identity?.name.trim() ||
        typeof (value as Partial<StoredCredentials>).identity?.email !== "string" ||
        !(value as Partial<StoredCredentials>).identity?.email.trim()))
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
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(temporary, testCredentialsFile);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup must not hide the original write or replacement error.
    }
  }
};

const credentialStoreHint =
  "Install the optional @napi-rs/keyring dependency and ensure your operating system's secure credential service is available.";

const nativeEntry = async (issuer: string) => {
  const { Entry } = await import("@napi-rs/keyring");
  return new Entry(SERVICE, accountFor(issuer));
};

const readNativePassword = async (issuer: string) => {
  const entry = await nativeEntry(issuer);
  const raw = entry.getPassword();
  const bun = (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
  if (raw !== null || !bun) return raw;
  const { findCredentials } = await import("@napi-rs/keyring");
  return (
    findCredentials(SERVICE).find(({ account }) => account === accountFor(issuer))?.password ?? null
  );
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
      raw = await readNativePassword(issuer);
    } catch (error) {
      throw new CliError("Unable to read the Weldall session from the secure credential store", {
        cause: error,
        hint: credentialStoreHint,
      });
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
      throw new CliError("Unable to save the Weldall session in the secure credential store", {
        cause: error,
        hint: credentialStoreHint,
      });
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
      throw new CliError("Unable to remove the Weldall session from the secure credential store", {
        cause: error,
        hint: credentialStoreHint,
      });
    }
  },
};
