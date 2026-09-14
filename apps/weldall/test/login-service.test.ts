import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  installation: vi.fn(),
  provider: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("@weldall/db", () => ({
  db: {
    $queryRaw: mocks.claim,
    loginInstallation: { findUniqueOrThrow: mocks.installation },
    loginProvider: { findUnique: mocks.provider },
  },
  ensureSystemScopes: vi.fn(),
  ADMIN_SCOPE_KEY: "weldall:administer",
  LOGIN_SCOPE_KEY: "weldall:login",
}));
vi.mock("../src/server/auth/oidc-runtime", () => ({
  verifyCallback: mocks.verify,
  authorizationUrl: vi.fn(),
}));
import {
  callbackUrl,
  consumeAttempt,
  verifyAttempt,
  type ConsumedAttempt,
} from "../src/server/auth/login-service";
import { digest, seal } from "../src/server/auth/oidc-credentials";
import { providerConfigSchema } from "../src/server/auth/oidc-config";
const config = providerConfigSchema.parse({
  name: "OIDC",
  buttonLabel: "Login",
  buttonColor: "#ffffff",
  issuer: "https://id.example.com",
  clientId: "client",
  clientSecret: "secret",
  tokenEndpointAuthMethod: "client_secret_post",
});
const providerId = "00000000-0000-4000-8000-000000000001";
const state = "s".repeat(43);
const token = "t".repeat(43);
let attempt: ConsumedAttempt;
beforeEach(() => {
  vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 2).toString("base64"));
  vi.stubEnv("WELDALL_SETUP_TOKEN", token);
  mocks.claim.mockReset();
  mocks.installation.mockReset().mockResolvedValue({ state: "UNINITIALIZED" });
  mocks.provider.mockReset().mockResolvedValue({
    ...config,
    id: providerId,
    enabled: true,
    version: 1,
    encryptedClientSecret: seal("provider", providerId, config.clientSecret),
  });
  mocks.verify.mockReset().mockResolvedValue({
    issuer: config.issuer,
    subject: "alice",
    email: "alice@example.com",
    name: "Alice",
  });
  attempt = {
    id: digest(state),
    state,
    providerId,
    providerVersion: 1,
    mode: "login",
    encryptedPayload: "",
    payload: {
      config,
      nonce: "nonce",
      verifier: "verifier",
      returnTo: "/",
      adminEmail: "alice@example.com",
      setupTokenHash: digest(token),
    },
  };
});
afterEach(() => vi.unstubAllEnvs());
it("claims the browser/provider/expiry-bound database attempt before exposing authenticated expected state", async () => {
  const { state: _, payload, ...row } = attempt;
  mocks.claim.mockResolvedValueOnce([
    { ...row, encryptedPayload: seal("attempt", row.id, JSON.stringify(payload)) },
  ]);
  const consumed = await consumeAttempt(providerId, state, "browser");
  expect(consumed.state).toBe(state);
  expect(consumed.payload.config).toEqual(config);
  const [sql, ...values] = mocks.claim.mock.calls[0]!;
  expect(sql.join("?")).toContain('DELETE FROM "LoginAttempt"');
  expect(sql.join("?")).toContain('"browserHash" = ? AND "expiresAt" >');
  expect(values.slice(0, 3)).toEqual([digest(state), providerId, digest("browser")]);
  expect(values[3]).toBeInstanceOf(Date);
  expect(mocks.verify).not.toHaveBeenCalled();
});
it("does not verify an unmatched browser, expired or already consumed database claim", async () => {
  mocks.claim.mockResolvedValue([]);
  await expect(consumeAttempt(providerId, state, "other-browser")).rejects.toThrow(
    "invalid_attempt",
  );
  expect(mocks.verify).not.toHaveBeenCalled();
});
it.each(["login", "setup", "setup-test", "provider-test"])(
  "uses the same adapter for %s with server-owned callback and complete duplicate-preserving query",
  async (mode) => {
    attempt.mode = mode;
    const query =
      "?state=untrusted&code=one&code=two&iss=https%3A%2F%2Fid.example.com&custom=a&custom=b";
    await verifyAttempt(attempt, query);
    const [provider, callback, expectedState, nonce, verifier] = mocks.verify.mock.calls[0]!;
    expect(provider).toEqual(config);
    expect(callback.toString()).toBe(`${callbackUrl(providerId)}${query}`);
    expect(callback.searchParams.getAll("code")).toEqual(["one", "two"]);
    expect(expectedState).toBe(state);
    expect(nonce).toBe(attempt.payload.nonce);
    expect(verifier).toBe(attempt.payload.verifier);
  },
);
it("rechecks provider availability/version independently of adapter cache", async () => {
  mocks.provider.mockResolvedValueOnce({ enabled: false });
  await expect(verifyAttempt(attempt, "?state=state&code=code")).rejects.toThrow(
    "provider_unavailable",
  );
  attempt.providerVersion = 2;
  await expect(verifyAttempt(attempt, "?state=state&code=code")).rejects.toThrow(
    "provider_changed",
  );
  expect(mocks.verify).not.toHaveBeenCalled();
});
it.each(["setup", "setup-test"])(
  "rechecks %s authorization before and after exchange",
  async (mode) => {
    attempt.mode = mode;
    mocks.verify.mockImplementationOnce(async () => {
      vi.stubEnv("WELDALL_SETUP_TOKEN", "r".repeat(43));
      return { issuer: config.issuer, subject: "alice", email: "alice@example.com", name: "Alice" };
    });
    await expect(verifyAttempt(attempt, "?state=state&code=code")).rejects.toThrow(
      "setup_unauthorized",
    );
    await expect(verifyAttempt(attempt, "?state=state&code=code")).rejects.toThrow(
      "setup_unauthorized",
    );
    expect(mocks.verify).toHaveBeenCalledOnce();
  },
);
