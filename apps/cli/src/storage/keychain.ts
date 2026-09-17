import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { JWK } from "jose";
import { CliError } from "../errors.js";
import { installMode } from "../install-mode.js";
import { atomicWriteFile } from "./atomic-write.js";

const SERVICE =
  installMode === "standalone" ? "dev.seibert.weldall-cli.standalone" : "dev.seibert.weldall-cli";
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
const macOsLegacyItemHint = `If a session from an older CLI build blocks the keychain, remove it with: security delete-generic-password -s ${SERVICE}`;

const execFileAsync = promisify(execFile);
const isMacOs = () => process.platform === "darwin";
const isBun = () => (globalThis as typeof globalThis & { Bun?: unknown }).Bun !== undefined;

// Writes and deletes can collide with a legacy item on macOS (see deleteMacOsItem); reads
// cannot, so only they get the extra hint.
const writeHint = () =>
  isMacOs() ? `${credentialStoreHint} ${macOsLegacyItemHint}` : credentialStoreHint;

// The credential item must be created by this process so macOS binds the item's access
// control list (and, for Developer-ID-signed builds, its partition list) to the CLI's own
// code signature. Earlier standalone builds delegated to `/usr/bin/security`, which left
// items readable by any process that could spawn that tool.
//
// Items created by those builds, or by an unsigned `node` binary of an npm install, are
// invisible to a signed process yet still block the name with errSecDuplicateItem, and the
// keyring addon cannot delete them. Worse, the addon's write tries to update an existing item
// in place, which on a foreign item raises an interactive authorization prompt; approving it
// would keep the item bound to the old owner. `security delete-generic-password` removes any
// such item without a prompt (exit 44 = nothing there). Deleting is the only use of the
// security tool: credentials are never read or written through it.
const deleteMacOsItem = async (service: string, account: string) => {
  try {
    await execFileAsync(
      "/usr/bin/security",
      ["delete-generic-password", "-s", service, "-a", account],
      { encoding: "utf8" },
    );
  } catch (error) {
    // 44 = errSecItemNotFound: nothing to remove.
    if ((error as { code?: unknown }).code === 44) return;
    throw error;
  }
};

export const nativeCredentialStore = {
  async get(service: string, account: string) {
    const { AsyncEntry, findCredentialsAsync } = await import("@napi-rs/keyring");
    const raw = await new AsyncEntry(service, account).getPassword();
    if (raw !== null && raw !== undefined) return raw;
    // Bun 1.3.14's compiled Intel macOS N-API path can return null for an exact lookup even
    // though the item exists; enumerating the service reads the same OS store. Node builds
    // never showed the quirk, so a miss there stays a single lookup.
    if (!isBun()) return null;
    return (
      (await findCredentialsAsync(service)).find((credential) => credential.account === account)
        ?.password ?? null
    );
  },

  async set(service: string, account: string, password: string) {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    // On macOS, drop any pre-existing item first so the addon always performs a clean insert
    // that binds the new item to this process's signature, never an in-place update of a
    // foreign item (see deleteMacOsItem). There is no prompt-free way to tell our own item from
    // a foreign one beforehand: a read of a foreign item raises the same authorization prompt
    // as a write (verified 2026-09-14 against a signed build and a `security`-created item).
    // Two consequences are accepted: a concurrent unlocked read can land in the brief
    // delete-to-insert window (SessionManager retries such a miss under withCredentialLock),
    // and an insert that fails after the delete succeeded costs the session, so the user logs
    // in again.
    if (isMacOs()) await deleteMacOsItem(service, account);
    await new AsyncEntry(service, account).setPassword(password);
  },

  async clear(service: string, account: string) {
    // On macOS the addon's delete raises an authorization prompt for an item owned by a
    // different signature (a legacy `security`/`node` item) and then only reports false, so
    // logout would prompt and, if declined, leave the item behind. `security
    // delete-generic-password` removes any item, ours or foreign, without a prompt.
    if (isMacOs()) {
      await deleteMacOsItem(service, account);
      return;
    }
    const { AsyncEntry } = await import("@napi-rs/keyring");
    await new AsyncEntry(service, account).deletePassword();
  },
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
      raw = (await nativeCredentialStore.get(SERVICE, account)) ?? null;
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
        hint: writeHint(),
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
      await nativeCredentialStore.clear(SERVICE, account);
    } catch (error) {
      throw new CliError("Unable to remove the Weldall session from the secure credential store", {
        cause: error,
        hint: writeHint(),
      });
    }
  },
};
