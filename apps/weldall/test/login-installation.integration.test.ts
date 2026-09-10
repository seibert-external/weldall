import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { ADMIN_SCOPE_KEY, LOGIN_SCOPE_KEY } from "@weldall/db";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const fixture = vi.hoisted(() => ({
  prisma: null as unknown as PrismaClient,
  claims: {} as Record<string, unknown>,
  nonce: "",
  offline: false,
  pauseDiscovery: null as (() => Promise<void>) | null,
  pauseExchange: null as (() => Promise<void>) | null,
  privateKey: null as unknown as CryptoKey,
  jwk: {} as Record<string, unknown>,
}));
vi.mock("@weldall/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // Better Auth retains its adapter client; delegate to the current disposable DB as well.
  db: new Proxy({} as PrismaClient, {
    get: (_, property) => {
      const value = Reflect.get(fixture.prisma, property);
      return typeof value === "function" ? value.bind(fixture.prisma) : value;
    },
  }),
}));
vi.mock("../src/server/auth/oidc-transport", () => ({
  oidcFetch: async (url: string) => {
    if (fixture.offline) throw new Error("fixture offline");
    if (url.endsWith("openid-configuration")) {
      await fixture.pauseDiscovery?.();
      return Response.json({
        issuer: "https://id.example.com",
        authorization_endpoint: "https://id.example.com/authorize",
        token_endpoint: "https://id.example.com/token",
        jwks_uri: "https://id.example.com/jwks",
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["ES256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.endsWith("/jwks")) return Response.json({ keys: [fixture.jwk] });
    if (url.endsWith("/token")) {
      await fixture.pauseExchange?.();
      return Response.json({
        access_token: "fixture-access-token",
        token_type: "Bearer",
        id_token: await new SignJWT({
          nonce: fixture.nonce,
          email: "alice@example.com",
          email_verified: true,
          ...fixture.claims,
        })
          .setProtectedHeader({ alg: "ES256", kid: "test" })
          .setIssuer("https://id.example.com")
          .setAudience("client")
          .setSubject("alice")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(fixture.privateKey),
      });
    }
    throw new Error("unexpected upstream");
  },
}));
import {
  completeVerifiedAttempt,
  consumeAttempt,
  firstProviderId,
  callbackUrl,
  linkIdentity,
  publicLoginProviders,
  startSetup,
  type ConsumedAttempt,
} from "../src/server/auth/login-service";
import { providerConfigSchema } from "../src/server/auth/oidc-config";
import { digest, seal } from "../src/server/auth/oidc-credentials";

const server = process.env.OIDC_TEST_SERVER_URL;
if (process.env.CI && process.env.CI !== "false" && !server)
  throw new Error(
    "OIDC_TEST_SERVER_URL is required in CI; PostgreSQL security tests must not skip.",
  );
const databaseName = `weldall_oidc_test_${randomUUID().replaceAll("-", "")}`;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const origin = "https://weldall.seibert.localdev";
const setupToken = "x".repeat(43);
const config = providerConfigSchema.parse({
  name: "Test",
  buttonLabel: "Continue",
  buttonColor: "#ffffff",
  issuer: "https://id.example.com",
  clientId: "client",
  clientSecret: "secret",
  tokenEndpointAuthMethod: "client_secret_post",
});
let nextHandlers: typeof import("../src/app/api/auth/[...all]/route");
let control: PrismaClient;
let created = false;
function deployMigrations(databaseUrl: string, schema = "prisma/schema.prisma") {
  execFileSync(
    "pnpm",
    ["--filter", "@weldall/db", "exec", "prisma", "migrate", "deploy", "--schema", schema],
    { cwd: root, env: { ...process.env, POSTGRES_URL: databaseUrl }, stdio: "pipe" },
  );
}
function withMigrationsThrough0014(run: (schema: string) => void) {
  const workspace = fileURLToPath(
    new URL(`../../../.tmp-prisma-prior-migrations-${randomUUID()}/`, import.meta.url),
  );
  try {
    const prisma = `${workspace}/prisma`;
    const migrations = `${prisma}/migrations`;
    mkdirSync(migrations, { recursive: true });
    cpSync(`${root}/packages/db/prisma/schema.prisma`, `${prisma}/schema.prisma`);
    cpSync(
      `${root}/packages/db/prisma/migrations/migration_lock.toml`,
      `${migrations}/migration_lock.toml`,
    );
    for (const name of [
      "0001_baseline",
      "0002_machine_clients",
      "0003_weldall_iac",
      "0004_iac_skills",
      "0005_iac_skill_binding",
      "0006_cli_logo_url",
      "0007_skill_metadata",
      "0008_cli_dark_logo_url",
      "0009_skill_retrieval_events",
      "0010_chat_tool_audit_events",
      "0011_chat_settings",
      "0012_initialize_chat_settings",
      "0013_chat_threads",
      "0014_chat_thread_heads",
    ])
      cpSync(`${root}/packages/db/prisma/migrations/${name}`, `${migrations}/${name}`, {
        recursive: true,
      });
    run(`${prisma}/schema.prisma`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const cookies = new Map<string, string>();
function cookieHeader() {
  return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}
async function request(path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const response = await (body ? nextHandlers.POST : nextHandlers.GET)(
    new Request(`${origin}/api/auth${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        cookie: cookieHeader(),
        ...(body ? { origin, "content-type": "application/json", "x-weldall-csrf": "1" } : {}),
        ...extraHeaders,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(";");
    const separator = pair!.indexOf("=");
    cookies.set(pair!.slice(0, separator), pair!.slice(separator + 1));
  }
  return response;
}
function attempt(providerId: string, mode = "setup", email = "alice@example.com"): ConsumedAttempt {
  return {
    id: randomUUID(),
    state: "s".repeat(43),
    providerId,
    providerVersion: mode === "login" ? 1 : null,
    mode,
    encryptedPayload: "",
    payload: {
      config,
      nonce: "nonce",
      verifier: "verifier",
      returnTo: "/",
      adminEmail: email,
      setupTokenHash: digest(setupToken),
    },
  };
}
async function snapshot() {
  return {
    installation: await fixture.prisma.loginInstallation.findMany(),
    providers: await fixture.prisma.loginProvider.findMany(),
    users: await fixture.prisma.user.findMany(),
    accounts: await fixture.prisma.account.findMany(),
    sessions: await fixture.prisma.session.findMany(),
    assignments: await fixture.prisma.emailScopeAssignment.findMany(),
    scopes: await fixture.prisma.scope.findMany(),
    grants: await fixture.prisma.emailScopeGrant.findMany(),
    audits: await fixture.prisma.auditEvent.findMany(),
  };
}
const setupBody = (mode: "setup" | "setup-test") => ({
  mode,
  ...(mode === "setup-test" ? { testId: randomUUID() } : {}),
  token: setupToken,
  adminEmail: "alice@example.com",
  acknowledgeAuthority: true,
  config,
});
async function beginSetup(mode: "setup" | "setup-test") {
  const body = setupBody(mode);
  const response = await request("/oidc/setup", body);
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  expect(
    response.headers.getSetCookie().every((cookie) => !cookie.includes("setup-provider")),
  ).toBe(true);
  const url = new URL(result.url);
  const providerId = await firstProviderId();
  expect(url.searchParams.get("redirect_uri")).toBe(callbackUrl(providerId));
  return {
    url,
    path: `/callback/${providerId}?state=${url.searchParams.get("state")}&code=test`,
    nonce: url.searchParams.get("nonce")!,
    testId: "testId" in body ? body.testId : undefined,
  };
}
function expectTestResult(
  response: Response,
  mode: "setup-test" | "provider-test",
  testId: string,
  passed: boolean,
) {
  expect(response.status).toBe(302);
  expect(response.headers.getSetCookie()).toEqual([]);
  const location = new URL(response.headers.get("location")!);
  expect(`${location.origin}${location.pathname}`).toBe(`${origin}/login/test-result`);
  expect(Object.fromEntries(location.searchParams)).toEqual({
    mode,
    testId,
    passed: String(passed),
  });
}
async function freshInstallation(run: () => Promise<void>) {
  const name = `weldall_oidc_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(server!);
  url.pathname = `/${name}`;
  const original = fixture.prisma;
  const originalCookies = new Map(cookies);
  execFileSync("psql", [server!, "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${name}"`]);
  try {
    deployMigrations(url.toString());
    fixture.prisma = new PrismaClient({ datasourceUrl: url.toString() });
    cookies.clear();
    await run();
  } finally {
    fixture.pauseDiscovery = null;
    fixture.pauseExchange = null;
    fixture.claims = {};
    vi.stubEnv("WELDALL_SETUP_TOKEN", setupToken);
    if (fixture.prisma !== original) await fixture.prisma.$disconnect();
    fixture.prisma = original;
    cookies.clear();
    for (const [key, value] of originalCookies) cookies.set(key, value);
    execFileSync("psql", [server!, "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE "${name}"`]);
  }
}
describe.skipIf(!server)("login installation (isolated real PostgreSQL)", () => {
  beforeAll(async () => {
    const url = new URL(server!);
    url.pathname = `/${databaseName}`;
    execFileSync("psql", [
      server!,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `CREATE DATABASE "${databaseName}"`,
    ]);
    created = true;
    deployMigrations(url.toString());
    fixture.prisma = new PrismaClient({ datasourceUrl: url.toString() });
    control = new PrismaClient({ datasourceUrl: url.toString() });
    vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 2).toString("base64"));
    vi.stubEnv("WELDALL_SETUP_TOKEN", setupToken);
    const keys = await generateKeyPair("ES256", { extractable: true });
    fixture.privateKey = keys.privateKey;
    fixture.jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "ES256" };
    vi.stubEnv("BETTER_AUTH_SECRET", "a-test-secret-with-at-least-thirty-two-characters");
    vi.stubEnv("WELDALL_SIGNING_KID", "test");
    vi.stubEnv("WELDALL_SIGNING_PRIVATE_JWK", JSON.stringify(await exportJWK(keys.privateKey)));
    vi.stubEnv("WELDALL_SIGNING_PUBLIC_JWK", JSON.stringify(await exportJWK(keys.publicKey)));
    vi.stubEnv("WELDALL_SKIP_RESOURCE_SEED", "true");
    nextHandlers = await import("../src/app/api/auth/[...all]/route");
  }, 60000);
  afterAll(async () => {
    await fixture.prisma?.$disconnect();
    await control?.$disconnect();
    if (created)
      execFileSync("psql", [
        server!,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `DROP DATABASE "${databaseName}"`,
      ]);
    vi.unstubAllEnvs();
  });
  it("replays all migrations and initializes singleton without any provider", async () => {
    expect(
      (await fixture.prisma.loginInstallation.findUniqueOrThrow({ where: { id: "default" } }))
        .state,
    ).toBe("UNINITIALIZED");
    expect(await publicLoginProviders()).toEqual([]);
  });
  it.each(["WELDALL_SETUP_TOKEN", "WELDALL_CREDENTIAL_ENCRYPTION_KEY"])(
    "rejects setup submission without attempts when %s is missing",
    async (name) => {
      const previous = process.env[name];
      vi.stubEnv(name, undefined);
      try {
        const response = await request("/oidc/setup", {
          mode: "setup",
          token: setupToken,
          adminEmail: "alice@example.com",
          acknowledgeAuthority: true,
          config,
        });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "setup_unavailable" });
        expect(await fixture.prisma.loginAttempt.count()).toBe(0);
        expect(await fixture.prisma.user.count()).toBe(0);
        expect(await fixture.prisma.auditEvent.count()).toBe(0);
      } finally {
        vi.stubEnv(name, previous);
      }
    },
  );
  it("rejects CSRF and wrong operator token without attempts or writes", async () => {
    const body = {
      mode: "setup",
      token: setupToken,
      adminEmail: "alice@example.com",
      acknowledgeAuthority: true,
      config,
    };
    expect(
      (await request("/oidc/setup", body, { origin: "https://evil.example.com" })).status,
    ).toBe(403);
    expect((await request("/oidc/setup", { ...body, token: "wrong" })).status).toBe(400);
    expect(await fixture.prisma.loginAttempt.count()).toBe(0);
    expect(await fixture.prisma.user.count()).toBe(0);
    expect(await fixture.prisma.auditEvent.count()).toBe(0);
  });
  it("keeps one server-owned callback across tabs, secret changes and long form dwell without a draft cookie", async () => {
    const initial = await firstProviderId();
    expect(new Set(await Promise.all(Array.from({ length: 8 }, () => firstProviderId())))).toEqual(
      new Set([initial]),
    );
    const removed = await request("/oidc/setup-context");
    expect(removed.status).toBe(404);
    expect(removed.headers.getSetCookie()).toEqual([]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86400000);
    try {
      vi.stubEnv("WELDALL_SETUP_TOKEN", "z".repeat(43));
      expect(await firstProviderId()).toBe(initial);
      const start = await request(
        "/oidc/setup",
        {
          ...setupBody("setup"),
          token: "z".repeat(43),
          config: {
            ...config,
            discoveryUrl: `https://id.example.com/${randomUUID()}/openid-configuration`,
          },
        },
        { cookie: "" },
      );
      expect(start.status).toBe(200);
      const url = new URL((await start.json()).url);
      expect(url.searchParams.get("redirect_uri")).toBe(callbackUrl(initial));
      const row = await fixture.prisma.loginAttempt.findUniqueOrThrow({
        where: { id: digest(url.searchParams.get("state")!) },
      });
      expect(row.expiresAt.getTime()).toBe(Date.now() + 600000);
      await fixture.prisma.loginAttempt.delete({ where: { id: row.id } });
    } finally {
      clock.mockRestore();
      vi.stubEnv("WELDALL_SETUP_TOKEN", setupToken);
      cookies.clear();
    }
    expect(await fixture.prisma.loginProvider.count()).toBe(0);
  });
  it("setup modes reject caller IDs, wrong tokens/origins/CSRF and test-mode confusion without side effects", async () => {
    const before = await snapshot();
    for (const mode of ["setup", "setup-test"] as const) {
      const body = setupBody(mode);
      for (const headers of [
        { origin: "https://evil.example.com" },
        { "x-weldall-csrf": "" },
        { "sec-fetch-site": "cross-site" },
      ])
        expect((await request("/oidc/setup", body, headers)).status).toBe(403);
      for (const extra of [
        { token: "wrong" },
        { providerId: randomUUID() },
        { mode: "provider-test" },
      ])
        expect((await request("/oidc/setup", { ...body, ...extra })).status).toBe(400);
    }
    expect(
      (await request("/oidc/setup", { ...setupBody("setup"), testId: randomUUID() })).status,
    ).toBe(400);
    const { testId: _, ...withoutTestId } = setupBody("setup-test");
    expect((await request("/oidc/setup", withoutTestId)).status).toBe(400);
    expect(await fixture.prisma.loginAttempt.count()).toBe(0);
    expect(await snapshot()).toEqual(before);
  });
  it("optional setup tests pass/fail against the nominated verified email with no persistent side effects; completion after failure is independent", async () => {
    await freshInstallation(async () => {
      const before = await snapshot();
      for (const claims of [
        {},
        { email: "wrong@example.com" },
        { email_verified: "true" },
        { email_verified: false },
      ]) {
        const flow = await beginSetup("setup-test");
        expect(await snapshot()).toEqual(before);
        fixture.nonce = flow.nonce;
        fixture.claims = claims;
        const result = await request(flow.path);
        expectTestResult(result, "setup-test", flow.testId!, Object.keys(claims).length === 0);
        expect(await snapshot()).toEqual(before);
        expect(await fixture.prisma.loginAttempt.count()).toBe(0);
        expect((await request(flow.path)).headers.get("location")).toContain("invalid_attempt");
        expect(await snapshot()).toEqual(before);
      }
      fixture.claims = {};
      const complete = await beginSetup("setup");
      fixture.nonce = complete.nonce;
      expect((await request(complete.path)).headers.get("location")).toBe(`${origin}/`);
      expect(await fixture.prisma.emailScopeGrant.count()).toBe(2);
      expect(await fixture.prisma.session.count()).toBe(1);
      expect(await fixture.prisma.auditEvent.count()).toBe(1);
    });
  });
  it("setup-test remains browser-bound, expiring, cancellable and unable to complete through the service", async () => {
    await freshInstallation(async () => {
      const before = await snapshot();
      const bound = await beginSetup("setup-test");
      fixture.nonce = bound.nonce;
      expect(
        (await request(bound.path, undefined, { cookie: "" })).headers.get("location"),
      ).toContain("invalid_attempt");
      expect(await fixture.prisma.loginAttempt.count()).toBe(1);
      expectTestResult(await request(bound.path), "setup-test", bound.testId!, true);
      const expired = await beginSetup("setup-test");
      await fixture.prisma.loginAttempt.updateMany({
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      expect((await request(expired.path)).headers.get("location")).toContain("invalid_attempt");
      const cancelled = await beginSetup("setup-test");
      expectTestResult(
        await request(`${cancelled.path}&error=access_denied`),
        "setup-test",
        cancelled.testId!,
        false,
      );
      await expect(
        completeVerifiedAttempt(attempt(await firstProviderId(), "setup-test"), {
          issuer: config.issuer,
          subject: "alice",
          email: "alice@example.com",
          name: "Alice",
        }),
      ).rejects.toThrow("setup_email_mismatch");
      expect(await snapshot()).toEqual(before);
      expect(await fixture.prisma.loginAttempt.count()).toBe(0);
    });
  });
  it.each(["setup", "setup-test"] as const)(
    "%s rejects operator token revocation before and during callback without side effects",
    async (mode) => {
      await freshInstallation(async () => {
        const before = await snapshot();
        const revoked = await beginSetup(mode);
        fixture.nonce = revoked.nonce;
        vi.stubEnv("WELDALL_SETUP_TOKEN", "z".repeat(43));
        const failed = await request(revoked.path);
        if (mode === "setup")
          expect(failed.headers.get("location")).toContain("setup_unauthorized");
        else expectTestResult(failed, "setup-test", revoked.testId!, false);
        vi.stubEnv("WELDALL_SETUP_TOKEN", setupToken);
        const flow = await beginSetup(mode);
        fixture.nonce = flow.nonce;
        const entered = barrier();
        const resume = barrier();
        fixture.pauseExchange = async () => {
          entered.release();
          await resume.promise;
        };
        const pending = request(flow.path);
        try {
          await entered.promise;
          vi.stubEnv("WELDALL_SETUP_TOKEN", undefined);
        } finally {
          resume.release();
        }
        const result = await pending;
        if (mode === "setup")
          expect(result.headers.get("location")).toContain("setup_unauthorized");
        else expectTestResult(result, "setup-test", flow.testId!, false);
        expect(await snapshot()).toEqual(before);
        expect(await fixture.prisma.loginAttempt.count()).toBe(0);
      });
    },
  );
  it("completion prunes both setup capabilities and rejects a consumed setup-test after exchange", async () => {
    await freshInstallation(async () => {
      const test = await beginSetup("setup-test");
      const complete = await beginSetup("setup");
      const outstandingTest = await beginSetup("setup-test");
      const outstandingSetup = await beginSetup("setup");
      fixture.nonce = test.nonce;
      const entered = barrier();
      const resume = barrier();
      fixture.pauseExchange = async () => {
        entered.release();
        await resume.promise;
      };
      const pending = request(test.path);
      await entered.promise;
      fixture.pauseExchange = null;
      try {
        fixture.nonce = complete.nonce;
        expect((await request(complete.path)).headers.get("location")).toBe(`${origin}/`);
        fixture.nonce = test.nonce;
      } finally {
        resume.release();
      }
      const committed = await snapshot();
      expectTestResult(await pending, "setup-test", test.testId!, false);
      expect(await fixture.prisma.loginAttempt.count()).toBe(0);
      for (const path of [outstandingTest.path, outstandingSetup.path, complete.path])
        expect((await request(path)).headers.get("location")).toContain("invalid_attempt");
      for (const mode of ["setup", "setup-test"] as const)
        expect((await (await request("/oidc/setup", setupBody(mode))).json()).error).toBe(
          "setup_completed",
        );
      vi.stubEnv("WELDALL_SETUP_TOKEN", undefined);
      expect((await (await request("/oidc/setup", setupBody("setup"))).json()).error).toBe(
        "setup_completed",
      );
      expect(await snapshot()).toEqual(committed);
      expect(committed.providers[0]?.id).toBe(await firstProviderId());
    });
  });
  it.each(["setup", "setup-test"] as const)(
    "completion wins against %s discovery preflight without leaving a capability",
    async (mode) => {
      await freshInstallation(async () => {
        const entered = barrier();
        const resume = barrier();
        fixture.pauseDiscovery = async () => {
          entered.release();
          await resume.promise;
        };
        const pending = request("/oidc/setup", {
          ...setupBody(mode),
          config: {
            ...config,
            discoveryUrl: `https://id.example.com/${randomUUID()}/openid-configuration`,
          },
        });
        await entered.promise;
        fixture.pauseDiscovery = null;
        try {
          const completion = await beginSetup("setup");
          fixture.nonce = completion.nonce;
          expect((await request(completion.path)).headers.get("location")).toBe(`${origin}/`);
        } finally {
          resume.release();
        }
        expect((await (await pending).json()).error).toBe("setup_completed");
        expect(await fixture.prisma.loginAttempt.count()).toBe(0);
        expect(await fixture.prisma.loginProvider.count()).toBe(1);
        expect(await fixture.prisma.auditEvent.count()).toBe(1);
        expect(await fixture.prisma.session.count()).toBe(1);
      });
    },
  );
  it("callback boundary rejects ambiguous state without consumption, but consumes duplicate-code and invalid protocol responses without writes", async () => {
    await freshInstallation(async () => {
      const before = await snapshot();
      const flow = await beginSetup("setup");
      fixture.nonce = flow.nonce;
      const state = flow.url.searchParams.get("state")!;
      for (const query of ["code=test", `state=${state}&state=${state}&code=test`]) {
        expect(
          (await request(`/callback/${firstProviderId()}?${query}`)).headers.get("location"),
        ).toContain("invalid_callback");
        expect(await fixture.prisma.loginAttempt.count()).toBe(1);
        expect(await snapshot()).toEqual(before);
      }
      expect((await request(`${flow.path}&code=duplicate`)).headers.get("location")).toContain(
        "invalid_id_token",
      );
      expect(await fixture.prisma.loginAttempt.count()).toBe(0);
      expect((await request(flow.path)).headers.get("location")).toContain("invalid_attempt");
      for (const claims of [
        { nonce: "wrong" },
        { email: undefined },
        { email_verified: undefined },
      ]) {
        const invalid = await beginSetup("setup");
        fixture.nonce = invalid.nonce;
        fixture.claims = claims;
        expect((await request(invalid.path)).headers.get("location")).not.toBe(`${origin}/`);
        expect(await fixture.prisma.loginAttempt.count()).toBe(0);
        expect(await snapshot()).toEqual(before);
      }
    });
  });
  it("real signed callback rejects wrong email and replay without grants/session/provider", async () => {
    const ctx = { providerId: await firstProviderId() };
    const start = await request("/oidc/setup", {
      mode: "setup",
      token: setupToken,
      adminEmail: "admin@example.com",
      acknowledgeAuthority: true,
      config,
    });
    const result = await start.json();
    expect(start.status, JSON.stringify(result)).toBe(200);
    const upstream = new URL(result.url);
    fixture.nonce = upstream.searchParams.get("nonce")!;
    const path = `/callback/${ctx.providerId}?code=test&state=${upstream.searchParams.get("state")}&iss=${encodeURIComponent(config.issuer)}`;
    const response = await request(path);
    expect(response.headers.get("location")).toContain("setup_email_mismatch");
    expect((await request(path)).headers.get("location")).toContain("invalid_attempt");
    for (const count of [
      await fixture.prisma.user.count(),
      await fixture.prisma.session.count(),
      await fixture.prisma.loginProvider.count(),
      await fixture.prisma.emailScopeGrant.count(),
      await fixture.prisma.auditEvent.count(),
    ])
      expect(count).toBe(0);
  });
  it("completes without any prior optional test through Better Auth, preserves an existing verified user, and reads native session", async () => {
    const existing = await fixture.prisma.user.create({
      data: {
        id: randomUUID(),
        email: "alice@example.com",
        name: "Existing Alice",
        emailVerified: true,
      },
    });
    const ctx = { providerId: await firstProviderId() };
    const result = await (
      await request("/oidc/setup", {
        mode: "setup",
        token: setupToken,
        adminEmail: "ALICE@example.com",
        acknowledgeAuthority: true,
        config,
      })
    ).json();
    const upstream = new URL(result.url);
    fixture.nonce = upstream.searchParams.get("nonce")!;
    expect(upstream.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = await request(
      `/callback/${ctx.providerId}?code=test&state=${upstream.searchParams.get("state")}`,
    );
    expect(callback.headers.get("location")).toBe(`${origin}/`);
    const session = await (await request("/get-session")).json();
    expect(session.user.email).toBe("alice@example.com");
    expect(session.user.id).toBe(existing.id);
    expect(await fixture.prisma.emailScopeGrant.count()).toBe(2);
    expect(await fixture.prisma.auditEvent.count()).toBe(1);
    expect(await fixture.prisma.loginAttempt.count()).toBe(0);
    const account = await fixture.prisma.account.findFirstOrThrow();
    expect(account.accessToken).toBeNull();
    expect(account.refreshToken).toBeNull();
    expect(account.idToken).toBeNull();
    expect((await publicLoginProviders())[0]?.id).toBe(await firstProviderId());
    expect((await publicLoginProviders())[0]).not.toHaveProperty("clientSecret");
  });
  it("ordinary login reuses the linked user and rechecks verification on an existing binding", async () => {
    const provider = await fixture.prisma.loginProvider.findFirstOrThrow();
    const sessionsBefore = await fixture.prisma.session.count();
    async function login() {
      const start = await (
        await request("/oidc/start", {
          providerId: provider.id,
          returnTo: "/login?client_id=weldall-cli",
        })
      ).json();
      const url = new URL(start.url);
      fixture.nonce = url.searchParams.get("nonce")!;
      return request(`/callback/${provider.id}?state=${url.searchParams.get("state")}&code=repeat`);
    }
    expect((await login()).headers.get("location")).toBe(`${origin}/login?client_id=weldall-cli`);
    expect(await fixture.prisma.user.count()).toBe(1);
    expect(await fixture.prisma.account.count()).toBe(1);
    expect(await fixture.prisma.session.count()).toBe(sessionsBefore + 1);
    fixture.claims = { email_verified: "true" };
    expect((await login()).headers.get("location")).toContain("unverified_identity");
    fixture.claims = {};
    expect(await fixture.prisma.session.count()).toBe(sessionsBefore + 1);
    expect(await fixture.prisma.auditEvent.count()).toBe(1);
    expect(await fixture.prisma.emailScopeGrant.count()).toBe(2);
  });
  it("provider changes during code exchange prevent all login completion writes", async () => {
    const provider = await fixture.prisma.loginProvider.findFirstOrThrow();
    const flow = new URL(
      (await (await request("/oidc/start", { providerId: provider.id })).json()).url,
    );
    fixture.nonce = flow.searchParams.get("nonce")!;
    const entered = barrier();
    const resume = barrier();
    fixture.pauseExchange = async () => {
      entered.release();
      await resume.promise;
    };
    const pending = request(
      `/callback/${provider.id}?state=${flow.searchParams.get("state")}&code=test`,
    );
    try {
      await entered.promise;
      await control.loginProvider.update({
        where: { id: provider.id },
        data: { version: { increment: 1 } },
      });
      const before = await snapshot();
      resume.release();
      expect((await pending).headers.get("location")).toContain("provider_changed");
      expect(await snapshot()).toEqual(before);
      expect(await fixture.prisma.loginAttempt.count()).toBe(0);
    } finally {
      resume.release();
      await pending;
      fixture.pauseExchange = null;
    }
  });
  it("blocks alternate upstream linking, local signup, and verification routes in real auth configuration", async () => {
    const before = [
      await fixture.prisma.user.count(),
      await fixture.prisma.account.count(),
      await fixture.prisma.session.count(),
    ];
    for (const path of [
      "/sign-in/social",
      "/sign-in/email",
      "/sign-up/email",
      "/link-social",
      "/unlink-account",
      "/change-email",
      "/set-password",
      "/send-verification-email",
      "/verify-email",
    ])
      expect(
        (await request(path, { email: "attacker@example.com", provider: "google" })).status,
        path,
      ).toBe(404);
    expect([
      await fixture.prisma.user.count(),
      await fixture.prisma.account.count(),
      await fixture.prisma.session.count(),
    ]).toEqual(before);
  });
  it("rejects consumed/in-flight login after disable or version change without linking", async () => {
    const provider = await fixture.prisma.loginProvider.findFirstOrThrow();
    await fixture.prisma.loginProvider.update({
      where: { id: provider.id },
      data: { enabled: false, version: { increment: 1 } },
    });
    const identity = {
      issuer: config.issuer,
      subject: "new",
      email: "new@example.com",
      name: "New",
    };
    await expect(completeVerifiedAttempt(attempt(provider.id, "login"), identity)).rejects.toThrow(
      "provider_changed",
    );
    await fixture.prisma.loginProvider.update({
      where: { id: provider.id },
      data: { enabled: true },
    });
    await expect(completeVerifiedAttempt(attempt(provider.id, "login"), identity)).rejects.toThrow(
      "provider_changed",
    );
    expect(await fixture.prisma.user.count()).toBe(1);
    expect(await fixture.prisma.account.count()).toBe(1);
  });
  it("concurrent issuer/subject linking produces one user and no permission grants", async () => {
    const identity = {
      issuer: "https://second.example.com",
      subject: "alice",
      email: "linked@example.com",
      name: "Linked",
    };
    const users = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        fixture.prisma.$transaction((tx) =>
          linkIdentity(
            tx,
            { ...identity, issuer: `https://issuer${i % 2}.example.com` },
            randomUUID(),
          ),
        ),
      ),
    );
    expect(new Set(users.map((u) => u.id)).size).toBe(1);
    expect(await fixture.prisma.account.count({ where: { userId: users[0]!.id } })).toBe(2);
    const pairwise = await fixture.prisma.$transaction((tx) =>
      linkIdentity(
        tx,
        { ...identity, issuer: "https://issuer0.example.com", subject: "pairwise-subject" },
        randomUUID(),
      ),
    );
    expect(pairwise.id).toBe(users[0]!.id);
    const collision = await fixture.prisma.$transaction((tx) =>
      linkIdentity(
        tx,
        {
          ...identity,
          issuer: "https://independent.example.com",
          email: "independent@example.com",
        },
        randomUUID(),
      ),
    );
    expect(collision.id).not.toBe(users[0]!.id);
    expect(await fixture.prisma.emailScopeGrant.count()).toBe(2);
    await expect(
      fixture.prisma.$transaction((tx) =>
        linkIdentity(
          tx,
          { ...identity, issuer: "https://issuer0.example.com", email: "changed@example.com" },
          randomUUID(),
        ),
      ),
    ).rejects.toThrow("identity_email_changed");
    await fixture.prisma.user.create({
      data: {
        id: randomUUID(),
        email: "unverified@example.com",
        name: "Unverified",
        emailVerified: false,
      },
    });
    await expect(
      fixture.prisma.$transaction((tx) =>
        linkIdentity(tx, { ...identity, email: "unverified@example.com" }, randomUUID()),
      ),
    ).rejects.toThrow("local_identity_conflict");
  });
  it("atomic consume has exactly one winner across connections and binds browser/provider", async () => {
    const state = "s".repeat(43);
    const id = digest(state);
    const providerId = randomUUID();
    const payload = attempt(providerId).payload;
    await fixture.prisma.loginAttempt.create({
      data: {
        id,
        providerId,
        mode: "setup",
        browserHash: digest("browser"),
        encryptedPayload: seal("attempt", id, JSON.stringify(payload)),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await expect(consumeAttempt(providerId, state, "wrong")).rejects.toThrow("invalid_attempt");
    await expect(consumeAttempt(randomUUID(), state, "browser")).rejects.toThrow("invalid_attempt");
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => consumeAttempt(providerId, state, "browser")),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
  it("populated upgrade removes only exact legacy Google account bindings", async () => {
    const name = `weldall_oidc_test_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(server!);
    url.pathname = `/${name}`;
    execFileSync("psql", [server!, "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${name}"`]);
    const databaseUrl = url.toString();
    const upgrade = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      withMigrationsThrough0014((schema) => deployMigrations(databaseUrl, schema));
      const userId = randomUUID();
      const scopeId = randomUUID();
      const assignmentId = randomUUID();
      const grantId = randomUUID();
      const sessionId = randomUUID();
      const accountIds = {
        legacyGoogle: randomUUID(),
        googleDifferentIssuer: randomUUID(),
        nonGoogleAccountsIssuer: randomUUID(),
        nonGoogleDifferentIssuer: randomUUID(),
      };
      await upgrade.user.create({
        data: {
          id: userId,
          name: "Alice Upgrade",
          email: "alice-upgrade@example.com",
          emailVerified: true,
        },
      });
      await upgrade.scope.create({
        data: {
          id: scopeId,
          key: `upgrade:scope-${scopeId}`,
          description: "Upgrade scope",
          createdBy: "test",
          updatedBy: "test",
        },
      });
      await upgrade.emailScopeAssignment.create({
        data: {
          id: assignmentId,
          normalizedEmail: "alice-upgrade@example.com",
          createdBy: "test",
          updatedBy: "test",
        },
      });
      await upgrade.emailScopeGrant.create({
        data: { id: grantId, assignmentId, scopeId, createdBy: "test" },
      });
      await upgrade.session.create({
        data: {
          id: sessionId,
          token: `upgrade-session-${sessionId}`,
          userId,
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      await upgrade.account.createMany({
        data: [
          {
            id: accountIds.legacyGoogle,
            providerId: "google",
            issuer: "https://accounts.google.com",
            providerAccountId: "legacy-google",
            userId,
            accessToken: "old",
            refreshToken: "old-refresh",
          },
          {
            id: accountIds.googleDifferentIssuer,
            providerId: "google",
            issuer: "https://other.example.com",
            providerAccountId: "other-issuer",
            userId,
          },
          {
            id: accountIds.nonGoogleAccountsIssuer,
            providerId: "other",
            issuer: "https://accounts.google.com",
            providerAccountId: "other-provider",
            userId,
          },
          {
            id: accountIds.nonGoogleDifferentIssuer,
            providerId: "oidc",
            issuer: "https://id.example.com",
            providerAccountId: "oidc-provider",
            userId,
          },
        ],
      });
      const before = {
        user: await upgrade.user.findUniqueOrThrow({ where: { id: userId } }),
        grant: await upgrade.emailScopeGrant.findUniqueOrThrow({ where: { id: grantId } }),
        session: await upgrade.session.findUniqueOrThrow({ where: { id: sessionId } }),
      };
      deployMigrations(databaseUrl);
      deployMigrations(databaseUrl);
      expect(
        await upgrade.account.findUnique({ where: { id: accountIds.legacyGoogle } }),
      ).toBeNull();
      expect(
        await upgrade.account.findMany({
          where: {
            id: { in: Object.values(accountIds).filter((id) => id !== accountIds.legacyGoogle) },
          },
          orderBy: { id: "asc" },
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: accountIds.googleDifferentIssuer,
            providerId: "google",
            issuer: "https://other.example.com",
          }),
          expect.objectContaining({
            id: accountIds.nonGoogleAccountsIssuer,
            providerId: "other",
            issuer: "https://accounts.google.com",
          }),
          expect.objectContaining({
            id: accountIds.nonGoogleDifferentIssuer,
            providerId: "oidc",
            issuer: "https://id.example.com",
          }),
        ]),
      );
      expect(await upgrade.account.count()).toBe(3);
      expect(await upgrade.user.findUniqueOrThrow({ where: { id: userId } })).toEqual(before.user);
      expect(await upgrade.emailScopeGrant.findUniqueOrThrow({ where: { id: grantId } })).toEqual(
        before.grant,
      );
      expect(await upgrade.session.findUniqueOrThrow({ where: { id: sessionId } })).toEqual(
        before.session,
      );
      expect(
        (await upgrade.loginInstallation.findUniqueOrThrow({ where: { id: "default" } })).state,
      ).toBe("UNINITIALIZED");
    } finally {
      await upgrade.$disconnect();
      execFileSync("psql", [server!, "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE "${name}"`]);
    }
  });
  it("competing setup transactions cannot reopen completion or grant another admin", async () => {
    const before = await fixture.prisma.emailScopeGrant.count();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        completeVerifiedAttempt(attempt(randomUUID(), "setup", "other@example.com"), {
          issuer: config.issuer,
          subject: "other",
          email: "other@example.com",
          name: "Other",
        }),
      ),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(await fixture.prisma.emailScopeGrant.count()).toBe(before);
    expect(await fixture.prisma.auditEvent.count()).toBe(1);
  });
  it("two fresh setup completions race on a genuine DB row lock; exactly one wins", async () => {
    const raceName = `weldall_oidc_test_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(server!);
    url.pathname = `/${raceName}`;
    const original = fixture.prisma;
    execFileSync("psql", [server!, "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${raceName}"`]);
    try {
      execFileSync(
        "pnpm",
        [
          "--filter",
          "@weldall/db",
          "exec",
          "prisma",
          "migrate",
          "deploy",
          "--schema",
          "prisma/schema.prisma",
        ],
        { cwd: root, env: { ...process.env, POSTGRES_URL: url.toString() }, stdio: "pipe" },
      );
      fixture.prisma = new PrismaClient({ datasourceUrl: url.toString() });
      const providerId = await firstProviderId();
      const results = await Promise.allSettled([
        ...["one", "two"].map((name) =>
          completeVerifiedAttempt(attempt(providerId, "setup", `${name}@example.com`), {
            issuer: config.issuer,
            subject: name,
            email: `${name}@example.com`,
            name,
          }),
        ),
        startSetup({
          mode: "setup",
          token: setupToken,
          config,
          adminEmail: "draft@example.com",
          browser: "racing-browser",
        }),
      ]);
      expect(results.slice(0, 2).filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await fixture.prisma.loginAttempt.count()).toBe(0);
      expect(await fixture.prisma.user.count()).toBe(1);
      expect(await fixture.prisma.account.count()).toBe(1);
      expect(await fixture.prisma.loginProvider.count()).toBe(1);
      expect(await fixture.prisma.auditEvent.count()).toBe(1);
      expect(await fixture.prisma.emailScopeGrant.count()).toBe(2);
      expect(await fixture.prisma.session.count()).toBe(0);
    } finally {
      if (fixture.prisma !== original) await fixture.prisma.$disconnect();
      fixture.prisma = original;
      execFileSync("psql", [server!, "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE "${raceName}"`]);
    }
  }, 60000);
  it("Next POST preserves the CLI consent login-scope denial", async () => {
    const current = await (await request("/get-session")).json();
    const grants = await control.emailScopeGrant.findMany({
      where: {
        assignment: { normalizedEmail: current.user.email },
        scope: { key: LOGIN_SCOPE_KEY },
      },
    });
    expect(grants.length).toBeGreaterThan(0);
    await control.emailScopeGrant.deleteMany({ where: { id: { in: grants.map((g) => g.id) } } });
    try {
      const response = await request("/oauth2/consent", {
        accept: true,
        oauth_query: new URLSearchParams({
          client_id: "weldall-cli",
          redirect_uri: "http://127.0.0.1:43123/callback",
          state: "consent-test",
        }).toString(),
      });
      const body = await response.json();
      expect(body.redirect).toBe(true);
      expect(new URL(body.url).searchParams.get("error")).toBe("access_denied");
      expect(new URL(body.url).searchParams.get("state")).toBe("consent-test");
    } finally {
      await control.emailScopeGrant.createMany({ data: grants });
    }
  });
  for (const wait of ["discovery", "advisory-lock", "provider-lock"] as const) {
    it.each(["session", "session-expiry", "admin-grant"] as const)(
      `Next POST rejects %s revoked during ${wait} without provider/audit writes`,
      async (revocation) => {
        const current = await (await request("/get-session")).json();
        const session = await control.session.findUniqueOrThrow({
          where: { id: current.session.id },
        });
        const grants = await control.emailScopeGrant.findMany({
          where: {
            assignment: { normalizedEmail: current.user.email },
            scope: { key: ADMIN_SCOPE_KEY },
          },
        });
        expect(grants.length).toBeGreaterThan(0);
        const row = await control.loginProvider.findFirstOrThrow();
        const providersBefore = await control.loginProvider.findMany();
        const auditsBefore = await control.auditEvent.findMany();
        const entered = barrier();
        const resume = barrier();
        let held: Promise<void> | undefined;
        if (wait === "discovery")
          fixture.pauseDiscovery = async () => {
            entered.release();
            await resume.promise;
          };
        else {
          held = control.$transaction(
            async (tx) => {
              if (wait === "advisory-lock")
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(181923, 3)`;
              else
                await tx.$queryRaw`SELECT "id" FROM "LoginProvider" WHERE "id" = ${row.id} FOR UPDATE`;
              entered.release();
              await resume.promise;
            },
            { timeout: 10000 },
          );
          await entered.promise;
        }
        const pending = request("/oidc/admin-save", {
          providerId: row.id,
          expectedVersion: row.version,
          enabled: false,
          acknowledgeAuthority: true,
          acknowledgeLockout: true,
          config: {
            ...config,
            name: "Must not commit",
            ...(wait === "discovery"
              ? {
                  discoveryUrl: `https://id.example.com/${randomUUID()}/openid-configuration`,
                }
              : {}),
          },
        });
        try {
          if (wait === "discovery") await entered.promise;
          else
            await vi.waitFor(
              async () => {
                const blocked = await control.$queryRaw<Array<{ count: bigint }>>`
            SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
              AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
              AND (query LIKE '%pg_advisory_xact_lock%' OR query LIKE '%LoginProvider%')`;
                expect(Number(blocked[0]!.count)).toBeGreaterThan(0);
              },
              { timeout: 2000, interval: 10 },
            );
          // A separate connection commits revocation before discovery/the actual DB lock is released.
          if (revocation === "session") await control.session.delete({ where: { id: session.id } });
          else if (revocation === "session-expiry")
            await control.session.update({
              where: { id: session.id },
              data: { expiresAt: new Date(Date.now() - 1000) },
            });
          else
            await control.emailScopeGrant.deleteMany({
              where: { id: { in: grants.map((g) => g.id) } },
            });
          resume.release();
          await held;
          expect((await pending).status).toBe(400);
          expect(await control.loginProvider.findMany()).toEqual(providersBefore);
          expect(await control.auditEvent.findMany()).toEqual(auditsBefore);
        } finally {
          resume.release();
          await held;
          await pending;
          fixture.pauseDiscovery = null;
          await control.session.upsert({
            where: { id: session.id },
            create: session,
            update: session,
          });
          await control.emailScopeGrant.createMany({ data: grants, skipDuplicates: true });
        }
      },
    );
  }
  it("admin unsaved test uses real OIDC without provider/user/link/session/grant/audit side effects", async () => {
    fixture.claims = {};
    const snapshot = async () => ({
      providers: await fixture.prisma.loginProvider.findMany(),
      users: await fixture.prisma.user.findMany(),
      accounts: await fixture.prisma.account.findMany(),
      sessions: await fixture.prisma.session.findMany(),
      grants: await fixture.prisma.emailScopeGrant.findMany(),
      audits: await fixture.prisma.auditEvent.findMany(),
    });
    // Better Auth would refresh these still-valid sessions under an unrestricted lookup.
    await fixture.prisma.session.updateMany({
      data: {
        createdAt: new Date(Date.now() - 4 * 86400000),
        updatedAt: new Date(Date.now() - 3 * 86400000),
        expiresAt: new Date(Date.now() + 3 * 86400000),
      },
    });
    const before = await snapshot();
    const draft = await (await request("/oidc/admin-draft", {})).json();
    expect(draft.providerId).toBeTypeOf("string");
    const body = {
      providerId: draft.providerId,
      expectedVersion: 0,
      config: { ...config, name: "Unsaved test" },
      enabled: false,
      testId: randomUUID(),
    };
    const rejected = await request("/oidc/admin-test", {
      ...body,
      config: { ...body.config, clientSecret: "" },
    });
    expect(rejected.status).toBe(400);
    expect(await snapshot()).toEqual(before);
    const start = await request("/oidc/admin-test", body);
    expect(start.status).toBe(200);
    expect(await snapshot()).toEqual(before);
    const upstream = new URL((await start.json()).url);
    fixture.nonce = upstream.searchParams.get("nonce")!;
    const path = `/callback/${draft.providerId}?state=${upstream.searchParams.get("state")}&code=test`;
    const result = await request(path);
    expectTestResult(result, "provider-test", body.testId, true);
    expect(result.headers.getSetCookie().some((cookie) => cookie.includes("session_token"))).toBe(
      false,
    );
    expect(await snapshot()).toEqual(before);
    expect(await fixture.prisma.loginAttempt.count({ where: { mode: "provider-test" } })).toBe(0);
    expect((await request(path)).status).toBe(302);
    expect(await snapshot()).toEqual(before);
    const failedTestId = randomUUID();
    const failed = await request("/oidc/admin-test", { ...body, testId: failedTestId });
    const failedUrl = new URL((await failed.json()).url);
    fixture.nonce = failedUrl.searchParams.get("nonce")!;
    fixture.claims = { email_verified: "true" };
    expectTestResult(
      await request(
        `/callback/${draft.providerId}?state=${failedUrl.searchParams.get("state")}&code=test`,
      ),
      "provider-test",
      failedTestId,
      false,
    );
    expect(await snapshot()).toEqual(before);
    fixture.claims = {};
    const sessionBoundTestId = randomUUID();
    const sessionBound = new URL(
      (await (await request("/oidc/admin-test", { ...body, testId: sessionBoundTestId })).json())
        .url,
    );
    fixture.nonce = sessionBound.searchParams.get("nonce")!;
    expectTestResult(
      await request(
        `/callback/${draft.providerId}?state=${sessionBound.searchParams.get("state")}&code=test`,
        undefined,
        {
          cookie: cookieHeader()
            .split("; ")
            .filter((value) => !value.includes("session_token"))
            .join("; "),
        },
      ),
      "provider-test",
      sessionBoundTestId,
      false,
    );
    expect(await snapshot()).toEqual(before);
    const revokedTestId = randomUUID();
    const revoked = new URL(
      (await (await request("/oidc/admin-test", { ...body, testId: revokedTestId })).json()).url,
    );
    fixture.nonce = revoked.searchParams.get("nonce")!;
    const adminGrants = await fixture.prisma.emailScopeGrant.findMany({
      where: { scope: { key: ADMIN_SCOPE_KEY } },
    });
    await fixture.prisma.emailScopeGrant.deleteMany({
      where: { id: { in: adminGrants.map((grant) => grant.id) } },
    });
    const revokedSnapshot = await snapshot();
    expectTestResult(
      await request(
        `/callback/${draft.providerId}?state=${revoked.searchParams.get("state")}&code=test`,
      ),
      "provider-test",
      revokedTestId,
      false,
    );
    expect(await snapshot()).toEqual(revokedSnapshot);
    await fixture.prisma.emailScopeGrant.createMany({ data: adminGrants });
  });
  it("admin save rejects CSRF, non-admin, immutable issuer and stale versions; saves audit without secret DTOs", async () => {
    const draft = await (await request("/oidc/admin-draft", {})).json();
    const body = {
      providerId: draft.providerId,
      expectedVersion: 0,
      config,
      enabled: true,
      acknowledgeAuthority: true,
    };
    const before = await fixture.prisma.auditEvent.count();
    expect(
      (await request("/oidc/admin-save", body, { origin: "https://evil.example.com" })).status,
    ).toBe(403);
    expect((await request("/oidc/admin-save", body, { "x-weldall-csrf": "" })).status).toBe(403);
    expect((await request("/oidc/admin-save", body, { cookie: "" })).status).toBe(400);
    const grants = await fixture.prisma.emailScopeGrant.findMany({
      where: { scope: { key: ADMIN_SCOPE_KEY } },
    });
    expect(grants.length).toBeGreaterThan(0);
    await fixture.prisma.emailScopeGrant.deleteMany({
      where: { id: { in: grants.map((g) => g.id) } },
    });
    expect((await request("/oidc/admin-save", body)).status).toBe(400);
    expect((await request("/oidc/admin-test", { ...body, testId: randomUUID() })).status).toBe(400);
    await fixture.prisma.emailScopeGrant.createMany({ data: grants });
    expect(await fixture.prisma.auditEvent.count()).toBe(before);
    expect(
      await fixture.prisma.loginProvider.findUnique({ where: { id: draft.providerId } }),
    ).toBeNull();
    expect(
      (await request("/oidc/admin-save", { ...body, acknowledgeAuthority: false })).status,
    ).toBe(400);
    const saved = await request("/oidc/admin-save", body);
    expect(saved.status).toBe(200);
    const dto = (await saved.json()).provider;
    expect(dto.version).toBe(1);
    expect(dto.hasClientSecret).toBe(true);
    expect(dto).not.toHaveProperty("clientSecret");
    expect(dto).not.toHaveProperty("encryptedClientSecret");
    const { clientSecret: _, ...withoutSecret } = config;
    const update = { ...body, expectedVersion: 1, config: { ...withoutSecret, sortOrder: -2 } };
    expect(
      (
        await request("/oidc/admin-save", {
          ...update,
          config: { ...withoutSecret, issuer: "https://other.example.com" },
        })
      ).status,
    ).toBe(400);
    const results = await Promise.all([
      request("/oidc/admin-save", update),
      request("/oidc/admin-save", update),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await fixture.prisma.auditEvent.count()).toBe(before + 2);
    expect(
      (await fixture.prisma.loginProvider.findUniqueOrThrow({ where: { id: dto.id } })).version,
    ).toBe(2);
    const disabled = await request("/oidc/admin-save", {
      ...update,
      expectedVersion: 2,
      enabled: false,
    });
    expect(disabled.status).toBe(200);
    const last = (await fixture.prisma.loginProvider.findMany({ where: { enabled: true } }))[0]!;
    const lastBody = {
      ...update,
      providerId: last.id,
      expectedVersion: last.version,
      enabled: false,
      config: withoutSecret,
    };
    const lastDenied = await request("/oidc/admin-save", lastBody);
    expect((await lastDenied.json()).error).toBe("last_provider_acknowledgement_required");
    expect(
      (await request("/oidc/admin-save", { ...lastBody, acknowledgeLockout: true })).status,
    ).toBe(200);
    expect(await publicLoginProviders()).toEqual([]);
    for (const mode of ["setup", "setup-test"]) {
      const response = await request("/oidc/setup", {
        mode,
        ...(mode === "setup-test" ? { testId: randomUUID() } : {}),
        token: setupToken,
        adminEmail: "alice@example.com",
        acknowledgeAuthority: true,
        config,
      });
      expect((await response.json()).error).toBe("setup_completed");
    }
  });
  it("outage-safe disable/order/presentation retain validation; re-enable/authority edits preflight and invalidate old attempts", async () => {
    const row = (await fixture.prisma.loginProvider.findMany())[0]!;
    const { clientSecret: _, ...nonsecret } = config;
    const base = {
      providerId: row.id,
      expectedVersion: row.version,
      config: nonsecret,
      enabled: true,
      acknowledgeAuthority: true,
    };
    const enabled = (await (await request("/oidc/admin-save", base)).json()).provider;
    expect(enabled.enabled).toBe(true);
    const inFlight = new URL(
      (await (await request("/oidc/start", { providerId: row.id })).json()).url,
    );
    fixture.nonce = inFlight.searchParams.get("nonce")!;
    fixture.offline = true;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 360000);
    try {
      const disabledResponse = await request("/oidc/admin-save", {
        ...base,
        expectedVersion: enabled.version,
        enabled: false,
        acknowledgeLockout: true,
      });
      expect(disabledResponse.status).toBe(200);
      const disabled = (await disabledResponse.json()).provider;
      expect(disabled.validatedAt).toBe(enabled.validatedAt);
      const reorderedResponse = await request("/oidc/admin-save", {
        ...base,
        expectedVersion: disabled.version,
        enabled: false,
        config: { ...nonsecret, sortOrder: 8, buttonLabel: "Offline", name: "Outage" },
      });
      expect(reorderedResponse.status).toBe(200);
      const reordered = (await reorderedResponse.json()).provider;
      expect(reordered.validatedAt).toBe(enabled.validatedAt);
      const before = await fixture.prisma.auditEvent.count();
      expect(
        (await request("/oidc/admin-save", { ...base, expectedVersion: reordered.version })).status,
      ).toBe(400);
      expect(
        (
          await request("/oidc/admin-save", {
            ...base,
            expectedVersion: reordered.version,
            enabled: false,
            config: { ...nonsecret, allowedEmailDomains: ["example.com"] },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request("/oidc/admin-save", {
            ...base,
            expectedVersion: disabled.version,
            enabled: false,
          })
        ).status,
      ).toBe(400);
      expect(await fixture.prisma.auditEvent.count()).toBe(before);
      const failedLogin = await request(
        `/callback/${row.id}?state=${inFlight.searchParams.get("state")}&code=test`,
      );
      expect(failedLogin.headers.get("location")).toContain("provider_unavailable");
    } finally {
      fixture.offline = false;
      clock.mockRestore();
    }
  });
  it("serializes competing last-provider disables and enforces the provider-count bound without audit side effects", async () => {
    await fixture.prisma.loginProvider.updateMany({
      data: { enabled: true, version: { increment: 1 } },
    });
    const rows = await fixture.prisma.loginProvider.findMany();
    expect(rows).toHaveLength(2);
    const before = await fixture.prisma.auditEvent.count();
    const { clientSecret: _, ...nonsecret } = config;
    const results = await Promise.all(
      rows.map((row) =>
        request("/oidc/admin-save", {
          providerId: row.id,
          expectedVersion: row.version,
          config: nonsecret,
          enabled: false,
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await fixture.prisma.loginProvider.count({ where: { enabled: true } })).toBe(1);
    expect(await fixture.prisma.auditEvent.count()).toBe(before + 1);
    const template = rows[0]!;
    await fixture.prisma.loginProvider.createMany({
      data: Array.from({ length: 98 }, () => {
        const id = randomUUID();
        return {
          ...template,
          id,
          enabled: false,
          encryptedClientSecret: seal("provider", id, config.clientSecret),
        };
      }),
    });
    const draft = await (await request("/oidc/admin-draft", {})).json();
    const denied = await request("/oidc/admin-save", {
      providerId: draft.providerId,
      expectedVersion: 0,
      config,
      enabled: false,
    });
    expect((await denied.json()).error).toBe("too_many_providers");
    expect(await fixture.prisma.loginProvider.count()).toBe(100);
    expect(await fixture.prisma.auditEvent.count()).toBe(before + 1);
  });
});
