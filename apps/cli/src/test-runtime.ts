import { randomBytes } from "node:crypto";
import { CliError } from "./errors.js";

const diagnosticsHook = "WELDALL_TEST_RUNTIME_DIAGNOSTICS";
const keyringHook = "WELDALL_TEST_KEYRING_SMOKE";
const keychainGetHook = "WELDALL_TEST_KEYCHAIN_GET";

interface KeyringEntry {
  setPassword(secret: string): void | Promise<void>;
  getPassword(): string | null | undefined | Promise<string | null | undefined>;
  deletePassword(): void | Promise<unknown>;
}

interface TestRuntimeDependencies {
  loadKeyring?: () => Promise<{
    Entry: new (service: string, account: string) => KeyringEntry;
    AsyncEntry?: new (service: string, account: string) => KeyringEntry;
    findCredentialsAsync?: (
      service: string,
    ) => Promise<Array<{ account: string; password: string }>>;
  }>;
  keychainGet?: (issuer: string) => Promise<unknown>;
  wait?: (milliseconds: number) => Promise<void>;
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function runTestRuntimeHook(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: TestRuntimeDependencies = {},
) {
  const diagnosticsRequested = environment[diagnosticsHook] !== undefined;
  const keyringId = environment[keyringHook];
  const keychainIssuer = environment[keychainGetHook];
  if (!diagnosticsRequested && keyringId === undefined && keychainIssuer === undefined)
    return false;
  if (environment.NODE_ENV !== "test")
    throw new CliError(
      `${diagnosticsRequested ? diagnosticsHook : keyringId !== undefined ? keyringHook : keychainGetHook} is only allowed when NODE_ENV=test`,
    );
  if (diagnosticsRequested && environment[diagnosticsHook] !== "1")
    throw new CliError(`${diagnosticsHook} must be set to 1`);
  if (keyringId !== undefined && !/^[0-9A-Za-z_-]{8,100}$/.test(keyringId))
    throw new CliError(`${keyringHook} must contain a unique safe identifier`);
  if (keychainIssuer !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(keychainIssuer);
    } catch {
      throw new CliError(`${keychainGetHook} must contain a canonical HTTPS origin`);
    }
    if (parsed.protocol !== "https:" || parsed.origin !== keychainIssuer)
      throw new CliError(`${keychainGetHook} must contain a canonical HTTPS origin`);
  }

  const bun = (globalThis as typeof globalThis & { Bun?: { version: string } }).Bun;
  const result: {
    runtime: { name: "bun" | "node"; version: string };
    execArgv: string[];
    autoloadSentinels: { dotenv: boolean; bunfig: boolean };
    keyringRoundTrip?: boolean;
  } = {
    runtime: bun
      ? { name: "bun", version: bun.version }
      : { name: "node", version: process.versions.node },
    execArgv: [...process.execArgv],
    autoloadSentinels: {
      dotenv: environment.WELDALL_TEST_DOTENV_SENTINEL !== undefined,
      bunfig: environment.WELDALL_TEST_BUNFIG_SENTINEL !== undefined,
    },
  };

  if (keyringId !== undefined) {
    if (dependencies.loadKeyring === undefined) {
      const { nativeCredentialStore } = await import("./storage/keychain.js");
      const service = `dev.seibert.weldall-cli.smoke.${keyringId}`;
      const account = `account-${keyringId}`;
      const secret = randomBytes(32).toString("base64url");
      let primaryError: unknown;
      let cleanupError: unknown;
      try {
        await nativeCredentialStore.set(service, account, secret);
        if ((await nativeCredentialStore.get(service, account)) !== secret)
          throw new Error("Secure credential round trip differed");
        result.keyringRoundTrip = true;
      } catch (error) {
        primaryError = error;
      } finally {
        try {
          await nativeCredentialStore.clear(service, account);
        } catch (error) {
          cleanupError = error;
        }
      }
      if (primaryError !== undefined && cleanupError !== undefined)
        throw new AggregateError(
          [primaryError, cleanupError],
          "Secure credential round trip and cleanup both failed",
        );
      if (cleanupError !== undefined) throw cleanupError;
      if (primaryError !== undefined) throw primaryError;
    } else {
      const keyring = await (dependencies.loadKeyring?.() ?? import("@napi-rs/keyring"));
      // Exercise the same binding used by the production keychain.
      const Entry = keyring.AsyncEntry ?? keyring.Entry;
      const service = `dev.seibert.weldall-cli.smoke.${keyringId}`;
      const account = `account-${keyringId}`;
      const createEntry = () => new Entry(service, account);
      const readPassword = async () => {
        const exact = await createEntry().getPassword();
        // Bun 1.3.14's compiled Intel macOS N-API path can return null for an
        // exact Entry lookup even though the native Keychain item was written.
        // Enumerating the same service still exercises and reads the OS store.
        if (exact !== null && exact !== undefined) return exact;
        if (!bun) return exact;
        return (await keyring.findCredentialsAsync?.(service))?.find(
          (item) => item.account === account,
        )?.password;
      };
      const secret = randomBytes(32).toString("base64url");
      let primaryError: unknown;
      let cleanupError: unknown;
      try {
        await createEntry().setPassword(secret);
        let stored = await readPassword();
        // macOS Keychain writes can become visible slowly on a newly provisioned,
        // loaded Intel CI runner. Keep the real native round trip, but bound its
        // propagation allowance independently from command execution timeouts.
        for (let attempt = 1; stored !== secret && attempt < 300; attempt++) {
          await (dependencies.wait ?? wait)(100);
          stored = await readPassword();
        }
        if (stored !== secret) throw new Error("Secure credential round trip differed");
        result.keyringRoundTrip = true;
      } catch (error) {
        primaryError = error;
      } finally {
        try {
          await createEntry().deletePassword();
        } catch (error) {
          cleanupError = error;
        }
      }
      if (primaryError !== undefined && cleanupError !== undefined)
        throw new AggregateError(
          [primaryError, cleanupError],
          "Secure credential round trip and cleanup both failed",
        );
      if (cleanupError !== undefined) throw cleanupError;
      if (primaryError !== undefined) throw primaryError;
    }
  }

  if (keychainIssuer !== undefined) {
    const get =
      dependencies.keychainGet ??
      (async (issuer: string) => (await import("./storage/keychain.js")).keychain.get(issuer));
    await get(keychainIssuer);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  return true;
}
