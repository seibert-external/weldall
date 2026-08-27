import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { refresh } from "../oauth/session.js";
import {
  keychain,
  type StoredAccessSession,
  type StoredCredentials,
  type StoredCredentialsInput,
  type StoredCredentialsV2,
} from "../storage/keychain.js";
import { withCredentialLock } from "../storage/lock.js";
import { phaseTiming, timingNow } from "../timing.js";

export interface AccessSession extends StoredAccessSession {
  credentials: StoredCredentialsV2;
}

interface CredentialStore {
  get(issuer: string): Promise<StoredCredentials | null>;
  set(issuer: string, credentials: StoredCredentialsInput): Promise<void>;
}

type RefreshCredentials = typeof refresh;
type SessionLock = <T>(operation: () => Promise<T>) => Promise<T>;

const inputFrom = (
  credentials: StoredCredentials,
  patch: Partial<Pick<StoredCredentialsV2, "accessSession" | "identity">> = {},
  clearAccessSession = false,
): StoredCredentialsInput => ({
  privateJwk: credentials.privateJwk,
  publicJwk: credentials.publicJwk,
  refreshToken: credentials.refreshToken,
  ...(credentials.identity === undefined ? {} : { identity: credentials.identity }),
  ...(!clearAccessSession && credentials.version === 2 && credentials.accessSession !== undefined
    ? { accessSession: credentials.accessSession }
    : {}),
  ...patch,
});

const usable = (credentials: StoredCredentials, now: number): AccessSession | null => {
  if (credentials.version !== 2 || !credentials.accessSession) return null;
  return credentials.accessSession.expiresAt > now + 60
    ? { ...credentials.accessSession, credentials }
    : null;
};

export class SessionManager {
  constructor(
    private readonly config: WeldallConfig,
    private readonly store: CredentialStore = keychain,
    private readonly lock: SessionLock = (operation) =>
      withCredentialLock(config.issuer, operation),
    private readonly refreshCredentials: RefreshCredentials = refresh,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
  ) {}

  async getAccessSession(): Promise<AccessSession> {
    const readStartedAt = timingNow();
    const initial = await this.store.get(this.config.issuer);
    phaseTiming("keychain-read", readStartedAt);
    if (!initial)
      throw new CliError(`You are not logged in to ${this.config.issuer}`, {
        hint: "Run `weldall login` first.",
      });
    const cached = usable(initial, this.now());
    if (cached) {
      phaseTiming("session-reused", readStartedAt);
      return cached;
    }

    const refreshStartedAt = timingNow();
    const session = await this.lock(async () => {
      const credentials = await this.store.get(this.config.issuer);
      if (!credentials)
        throw new CliError(`You are not logged in to ${this.config.issuer}`, {
          hint: "Run `weldall login` first.",
        });
      const followerSession = usable(credentials, this.now());
      if (followerSession) return followerSession;

      const fresh = await this.refreshCredentials(this.config, credentials, async (rotated) => {
        // Persist rotation before any signing-key or access-token validation.
        await this.store.set(this.config.issuer, inputFrom(rotated, {}, true));
      });
      const accessSession: StoredAccessSession = {
        accessToken: fresh.accessToken,
        subject: fresh.subject,
        expiresAt: fresh.expiresAt as number,
      };
      await this.store.set(this.config.issuer, inputFrom(fresh.credentials, { accessSession }));
      const stored: StoredCredentialsV2 = {
        version: 2,
        issuer: this.config.issuer,
        ...inputFrom(fresh.credentials, { accessSession }),
      };
      return { ...accessSession, credentials: stored };
    });
    phaseTiming("session-refresh", refreshStartedAt);
    return session;
  }
}
