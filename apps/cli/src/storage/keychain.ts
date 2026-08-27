import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { JWK } from "jose";
import { CliError } from "../errors.js";
import { atomicWriteFile } from "./atomic-write.js";

const SERVICE = "dev.seibert.weldall-cli";
const CREDENTIALS_VERSION = 2 as const;
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

export interface StoredAccessSession {
  accessToken: string;
  subject: string;
  expiresAt: number;
}

interface StoredCredentialsBase {
  issuer: string;
  privateJwk: JWK;
  publicJwk: JWK;
  refreshToken: string;
  identity?: StoredIdentity;
}

export interface StoredCredentialsV1 extends StoredCredentialsBase {
  version: 1;
}

export interface StoredCredentialsV2 extends StoredCredentialsBase {
  version: typeof CREDENTIALS_VERSION;
  accessSession?: StoredAccessSession;
}

export type StoredCredentials = StoredCredentialsV1 | StoredCredentialsV2;
export type StoredCredentialsInput = Omit<StoredCredentialsBase, "issuer"> & {
  accessSession?: StoredAccessSession;
};

type TestKeychain = Record<string, StoredCredentials>;

const accountFor = (issuer: string) =>
  `session-${createHash("sha256").update(issuer).digest("base64url")}`;

const validAccessSession = (value: unknown): value is StoredAccessSession =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as Partial<StoredAccessSession>).accessToken === "string" &&
  Boolean((value as Partial<StoredAccessSession>).accessToken) &&
  typeof (value as Partial<StoredAccessSession>).subject === "string" &&
  Boolean((value as Partial<StoredAccessSession>).subject?.trim()) &&
  typeof (value as Partial<StoredAccessSession>).expiresAt === "number" &&
  Number.isInteger((value as Partial<StoredAccessSession>).expiresAt) &&
  (value as StoredAccessSession).expiresAt > 0;

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
    ((value as { version?: unknown }).version !== 1 &&
      (value as { version?: unknown }).version !== CREDENTIALS_VERSION) ||
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
        !(value as Partial<StoredCredentials>).identity?.email.trim())) ||
    ((value as { version?: unknown }).version === CREDENTIALS_VERSION &&
      (value as StoredCredentialsV2).accessSession !== undefined &&
      !validAccessSession((value as StoredCredentialsV2).accessSession))
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

const writeTestKeychain = async (value: TestKeychain) => {
  if (!testCredentialsFile) return;
  await atomicWriteFile(testCredentialsFile, JSON.stringify(value), {
    temporary: join(dirname(testCredentialsFile), `.weldall-${randomUUID()}.tmp`),
  });
};

const credentialStoreHint =
  "Install the optional @napi-rs/keyring dependency and ensure your operating system's secure credential service is available.";

const execFileAsync = promisify(execFile);
const usesMacOsSecurity =
  process.platform === "darwin" &&
  (globalThis as typeof globalThis & { Bun?: unknown }).Bun !== undefined;

const security = async (args: string[]) =>
  execFileAsync("/usr/bin/security", args, { encoding: "utf8", maxBuffer: 1024 * 1024 });

const nativeEntry = async (issuer: string) => {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return new AsyncEntry(SERVICE, accountFor(issuer));
};

export const nativeCredentialStore = {
  async get(service: string, account: string) {
    if (usesMacOsSecurity) {
      try {
        const { stdout } = await security([
          "find-generic-password",
          "-s",
          service,
          "-a",
          account,
          "-w",
        ]);
        return stdout.replace(/\r?\n$/, "");
      } catch (error) {
        if ((error as NodeJS.ErrnoException & { code?: number }).code === 44) return null;
        throw error;
      }
    }
    const { AsyncEntry } = await import("@napi-rs/keyring");
    const raw = await new AsyncEntry(service, account).getPassword();
    if (raw !== null && raw !== undefined) return raw;
    const { findCredentialsAsync } = await import("@napi-rs/keyring");
    return (
      (await findCredentialsAsync(service)).find((credential) => credential.account === account)
        ?.password ?? null
    );
  },

  async set(service: string, account: string, password: string) {
    if (usesMacOsSecurity) {
      await security(["add-generic-password", "-U", "-s", service, "-a", account, "-w", password]);
      return;
    }
    const { AsyncEntry } = await import("@napi-rs/keyring");
    await new AsyncEntry(service, account).setPassword(password);
  },

  async clear(service: string, account: string) {
    if (usesMacOsSecurity) {
      await security(["delete-generic-password", "-s", service, "-a", account]);
      return;
    }
    const { AsyncEntry } = await import("@napi-rs/keyring");
    await new AsyncEntry(service, account).deletePassword();
  },
};

const readNativePassword = async (issuer: string) => {
  if (usesMacOsSecurity) return nativeCredentialStore.get(SERVICE, accountFor(issuer));
  const entry = await nativeEntry(issuer);
  const raw = await entry.getPassword();
  const bun = (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
  if ((raw !== null && raw !== undefined) || !bun) return raw;
  const { findCredentialsAsync } = await import("@napi-rs/keyring");
  return (
    (await findCredentialsAsync(SERVICE)).find(({ account }) => account === accountFor(issuer))
      ?.password ?? null
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
      raw = (await readNativePassword(issuer)) ?? null;
    } catch (error) {
      throw new CliError("Unable to read the Weldall session from the secure credential store", {
        cause: error,
        hint: credentialStoreHint,
      });
    }
    return raw ? parseCredentials(raw, issuer) : null;
  },

  async set(issuer: string, credentials: StoredCredentialsInput) {
    const stored: StoredCredentialsV2 = {
      version: CREDENTIALS_VERSION,
      issuer,
      ...credentials,
    };
    if (testCredentialsFile) {
      const value = readTestKeychain();
      value[accountFor(issuer)] = stored;
      await writeTestKeychain(value);
      return;
    }
    try {
      await nativeCredentialStore.set(SERVICE, accountFor(issuer), JSON.stringify(stored));
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
      else await writeTestKeychain(value);
      return;
    }
    try {
      await nativeCredentialStore.clear(SERVICE, accountFor(issuer));
    } catch (error) {
      throw new CliError("Unable to remove the Weldall session from the secure credential store", {
        cause: error,
        hint: credentialStoreHint,
      });
    }
  },
};
