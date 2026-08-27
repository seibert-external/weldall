import { describe, expect, it, vi } from "vitest";
import { generateEs256KeyPair } from "@weldall/sdk";
import type { WeldallConfig } from "../src/config.js";
import { SessionManager } from "../src/services/session-manager.js";
import type {
  StoredCredentials,
  StoredCredentialsInput,
  StoredCredentialsV2,
} from "../src/storage/keychain.js";

const issuer = "https://weldall.example.com";
const config: WeldallConfig = {
  issuer,
  resource: `${issuer}/api`,
  authorize: `${issuer}/api/auth/oauth2/authorize`,
  token: `${issuer}/api/auth/oauth2/token`,
  revoke: `${issuer}/api/auth/oauth2/revoke`,
  jwks: `${issuer}/api/oauth/jwks`,
  cli: `${issuer}/api/me/cli`,
  grants: `${issuer}/api/me/grants`,
  scopes: `${issuer}/api/me/scopes`,
  skills: `${issuer}/api/me/skills`,
  userInfo: `${issuer}/api/auth/oauth2/userinfo`,
};

const storeFor = (initial: StoredCredentials) => {
  let value: StoredCredentials | null = initial;
  return {
    get: vi.fn(async () => value),
    set: vi.fn(async (_issuer: string, input: StoredCredentialsInput) => {
      value = { version: 2, issuer, ...input } as StoredCredentialsV2;
    }),
    current: () => value,
  };
};

const serialLock = () => {
  let tail = Promise.resolve();
  return async <T>(operation: () => Promise<T>) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
};

describe("SessionManager", () => {
  it("reuses a valid cached access session without refresh or write", async () => {
    const key = await generateEs256KeyPair();
    const credentials: StoredCredentialsV2 = {
      version: 2,
      issuer,
      ...key,
      refreshToken: "refresh",
      accessSession: { accessToken: "access", subject: "user", expiresAt: 2_000 },
    };
    const store = storeFor(credentials);
    const refresh = vi.fn();
    await expect(
      new SessionManager(
        config,
        store,
        serialLock(),
        refresh as any,
        () => 1_000,
      ).getAccessSession(),
    ).resolves.toMatchObject({ accessToken: "access", subject: "user", expiresAt: 2_000 });
    expect(refresh).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it.each([1_060, 900])("refreshes a near-expiry or expired session (%s)", async (expiresAt) => {
    const key = await generateEs256KeyPair();
    const credentials: StoredCredentialsV2 = {
      version: 2,
      issuer,
      ...key,
      refreshToken: "old-refresh",
      accessSession: { accessToken: "old-access", subject: "user", expiresAt },
    };
    const store = storeFor(credentials);
    const refresh = vi.fn(async (_config, current, onRotation) => {
      const rotated = { ...current, refreshToken: "new-refresh" };
      await onRotation(rotated);
      return {
        credentials: rotated,
        accessToken: "new-access",
        subject: "verified-user",
        expiresAt: 2_000,
      };
    });
    const session = await new SessionManager(
      config,
      store,
      serialLock(),
      refresh as any,
      () => 1_000,
    ).getAccessSession();
    expect(session).toMatchObject({
      accessToken: "new-access",
      subject: "verified-user",
      expiresAt: 2_000,
    });
    expect(store.set).toHaveBeenCalledTimes(2);
    expect((store.set.mock.calls[0]![1] as StoredCredentialsInput).refreshToken).toBe(
      "new-refresh",
    );
    expect((store.set.mock.calls[0]![1] as StoredCredentialsInput).accessSession).toBeUndefined();
    expect((store.current() as StoredCredentialsV2).accessSession).toMatchObject({
      subject: "verified-user",
      expiresAt: 2_000,
    });
  });

  it("migrates v1 credentials and lets refresh followers reuse the leader session", async () => {
    const key = await generateEs256KeyPair();
    const store = storeFor({
      version: 1,
      issuer,
      ...key,
      refreshToken: "old-refresh",
    });
    const refresh = vi.fn(async (_config, current, onRotation) => {
      const rotated = { ...current, refreshToken: "new-refresh" };
      await onRotation(rotated);
      await Promise.resolve();
      return {
        credentials: rotated,
        accessToken: "leader-access",
        subject: "user",
        expiresAt: 2_000,
      };
    });
    const lock = serialLock();
    const manager = () => new SessionManager(config, store, lock, refresh as any, () => 1_000);
    const [first, second] = await Promise.all([
      manager().getAccessSession(),
      manager().getAccessSession(),
    ]);
    expect(first.accessToken).toBe("leader-access");
    expect(second.accessToken).toBe("leader-access");
    expect(refresh).toHaveBeenCalledOnce();
    expect(store.current()).toMatchObject({ version: 2, refreshToken: "new-refresh" });
  });
});
