import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, ensureSystemScopes } from "@weldall/db";
import { generateEs256KeyPair } from "@weldall/sdk";
import { calculateJwkThumbprint } from "jose";
import { applyIac, planIac, getIacState } from "../src/server/iac/service";
import { mutateSkill } from "../src/server/domain/primitive-mutations";
import { executeMcpOperation, listMcpConnectors } from "../src/server/mcp/broker";
import { listConnectors, listConnections } from "../src/server/connectors/core/connections";
import {
  runConnectorTransaction,
  saveConnectorConfiguration,
  deleteConnectorConfiguration,
  buildConnectorState,
} from "../src/server/connectors/configuration";
import { ensureConnectorRegistration } from "../src/server/connectors/core/registration";
import { resolvePublicIpv4 } from "../src/server/connectors/core/secure-fetch";
import { encrypt } from "../src/server/connectors/encryption";
import {
  grantFromCredentials,
  registerAtlassianMcpClient,
} from "../src/server/connectors/providers/atlassian-mcp/oauth";
import {
  ATLASSIAN_MCP,
  canonicalScopes,
} from "../src/server/connectors/providers/atlassian-mcp/config";
import {
  startMcpFixture,
  FIXTURE_AUTHORIZATION,
  fixtureTools,
  type McpFixture,
  type FixtureOptions,
} from "./fixtures/mcp-server";
import { createMemoryMcpToolCache, type McpToolCache } from "../src/server/mcp/tool-cache";
import { logger } from "../src/server/observability/logger";
const network = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock("../src/server/connectors/core/secure-fetch", () => ({
  resolvePublicIpv4: vi.fn(async () => "93.184.216.34"),
  createPinnedFetch: () => network.fetch,
}));
vi.mock("../src/server/connectors/providers/atlassian-mcp/oauth", async (original) => ({
  ...(await original<object>()),
  registerAtlassianMcpClient: vi.fn(async () => ({ clientId: "fixture-public-client" })),
}));
const approved =
  /^postgresql:\/\/postgres@localhost:5433\/weldall_connector_test_[a-f0-9]{32}$/.test(
    process.env.POSTGRES_URL ?? "",
  ) ||
  (process.env.CI === "true" &&
    process.env.POSTGRES_URL === "postgresql://postgres:postgres@localhost:5432/postgres");
const prefix = `mcp-${randomBytes(6).toString("hex")}`;
const actor = { id: prefix, email: `${prefix}@example.com`, requestId: prefix, scopeKeys: [] };
const scopes = canonicalScopes([
  "read:me",
  "read:account",
  "offline_access",
  "read:jira:agent-interface",
]);
const cloudId = "00000000-0000-4000-8000-000000000001";
const accessToken = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "system-account", aud: [`ari:cloud:jira::site/${cloudId}`] })).toString("base64url")}.fake-signature`;
const credentials = {
  kind: "oauth",
  accessToken,
  refreshToken: "backend-only-refresh",
  expiresAt: Date.now() + 28800000,
  clientId: "public-client",
  grantedScopes: scopes,
};
const transaction = runConnectorTransaction;
const encryptedIds: string[] = [];
let sequence = 0;
async function setup(cache?: McpToolCache) {
  const key = `${prefix}-${++sequence}`;
  const connector = await transaction((tx) =>
    saveConnectorConfiguration({
      tx,
      value: {
        key,
        name: "Atlassian MCP",
        type: "atlassian-mcp",
        enabled: true,
        envelopeProvider: "LOCAL_ENV",
        requiredScopes: [],
        provider: {
          allowedScopes: ["read:jira:agent-interface"],
          defaultScopes: ["read:jira:agent-interface"],
        },
      },
      id: undefined,
      expectedVersion: null,
      actor,
    }),
  );
  const id = randomUUID();
  const encrypted = await db.encryptedValue.create({
    data: await encrypt({
      provider: "LOCAL_ENV",
      connectorId: connector.id,
      context: `connection:${id}:credentials`,
      plaintext: JSON.stringify(credentials),
    }),
  });
  encryptedIds.push(encrypted.id);
  const connection = await db.connection.create({
    data: {
      id,
      ownerId: actor.id,
      connectorId: connector.id,
      name: key,
      accountId: "system-account",
      accountName: "Disposable site",
      status: "READY",
      providerSelection: { scopes },
      providerGrant: grantFromCredentials(credentials),
      credentialId: encrypted.id,
    },
  });
  return {
    connector,
    connection,
    call: (
      operation: "call" | "tools" | "resources" | "read-resource",
      extra: object = {},
      caller = actor,
      signal = AbortSignal.timeout(5000),
    ) =>
      executeMcpOperation(
        {
          actor: caller,
          connectorKey: key,
          operation,
          body: { connection: id, ...extra },
          signal,
        },
        cache,
      ),
  };
}
let upstream: McpFixture;
describe.skipIf(!approved)(
  "governed MCP against isolated PostgreSQL and the actual SDK fixture",
  () => {
    beforeAll(async () => {
      vi.stubEnv("WELDALL_CONNECTOR_KEK", randomBytes(32).toString("base64"));
      await db.user.create({
        data: { id: actor.id, name: "Fixture", email: actor.email, emailVerified: true },
      });
      await ensureSystemScopes(db, actor.id);
      await db.emailScopeAssignment.create({
        data: {
          normalizedEmail: actor.email,
          createdBy: actor.id,
          updatedBy: actor.id,
          grants: { create: { scopeId: "scope-weldall-login", createdBy: actor.id } },
        },
      });
      upstream = await startMcpFixture();
      network.fetch.mockImplementation((url, init) => {
        expect(String(url)).toBe(ATLASSIAN_MCP.resource);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
        const headers = new Headers(init?.headers);
        headers.set("authorization", FIXTURE_AUTHORIZATION);
        return fetch(upstream.endpoint, { ...init, headers });
      });
    });
    afterAll(async () => {
      await upstream?.close();
      await db.skill.deleteMany({ where: { createdBy: actor.id } });
      await db.connection.deleteMany({ where: { ownerId: actor.id } });
      await db.connector.deleteMany({ where: { key: { startsWith: prefix } } });
      await db.encryptedValue.deleteMany({ where: { id: { in: encryptedIds } } });
      await db.iacOperation.deleteMany({ where: { workspace: { name: prefix } } });
      await db.iacObjectBinding.deleteMany({ where: { workspace: { name: prefix } } });
      await db.iacWorkspace.deleteMany({ where: { name: prefix } });
      await db.machineClient.deleteMany({ where: { clientId: actor.id } });
      await db.emailScopeAssignment.deleteMany({ where: { normalizedEmail: actor.email } });
      await db.user.deleteMany({ where: { id: actor.id } });
      await db.auditEvent.deleteMany({ where: { requestId: prefix } });
      vi.unstubAllEnvs();
    });
    it("keeps a reduced grant usable before and after refresh without a scope response", async () => {
      const f = await setup();
      const requested = canonicalScopes([...scopes, "search:jira:agent-interface"]);
      await db.connector.update({
        where: { id: f.connector.id },
        data: {
          providerConfig: {
            allowedScopes: ["read:jira:agent-interface", "search:jira:agent-interface"],
            defaultScopes: ["read:jira:agent-interface"],
          },
        },
      });
      await db.connection.update({
        where: { id: f.connection.id },
        data: { providerSelection: { scopes: requested } },
      });
      await expect(f.call("tools")).resolves.toHaveProperty("tools");
      await db.encryptedValue.update({
        where: { id: f.connection.credentialId! },
        data: await encrypt({
          provider: "LOCAL_ENV",
          connectorId: f.connector.id,
          context: `connection:${f.connection.id}:credentials`,
          plaintext: JSON.stringify({ ...credentials, expiresAt: 0 }),
        }),
      });
      const upstreamFetch = network.fetch.getMockImplementation()!;
      let refreshes = 0;
      network.fetch.mockImplementation(async (url, init) => {
        if (String(url) === ATLASSIAN_MCP.resourceMetadata)
          return Response.json({
            resource: ATLASSIAN_MCP.resource,
            authorization_servers: [ATLASSIAN_MCP.issuer],
            scopes_supported: requested,
          });
        if (String(url) === ATLASSIAN_MCP.metadata)
          return Response.json({
            issuer: ATLASSIAN_MCP.issuer,
            authorization_endpoint: ATLASSIAN_MCP.authorization,
            token_endpoint: ATLASSIAN_MCP.token,
            registration_endpoint: ATLASSIAN_MCP.registration,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
        if (String(url) === ATLASSIAN_MCP.token) {
          refreshes++;
          return Response.json({
            access_token: accessToken,
            refresh_token: "rotated-backend-only-refresh",
            token_type: "Bearer",
            expires_in: 28800,
          });
        }
        return upstreamFetch(url, init);
      });
      const listCount = () =>
        upstream.requests.filter(
          (r) => r.message && "method" in r.message && r.message.method === "tools/list",
        ).length;
      const beforeRefresh = listCount();
      try {
        await expect(f.call("tools")).resolves.toHaveProperty("tools");
        expect(listCount() - beforeRefresh).toBe(2);
        await expect(f.call("tools")).resolves.toHaveProperty("tools");
        expect(listCount() - beforeRefresh).toBe(2);
        expect(refreshes).toBe(1);
        expect(
          await db.connection.findUniqueOrThrow({ where: { id: f.connection.id } }),
        ).toMatchObject({ status: "READY", providerGrant: { scopes } });
      } finally {
        network.fetch.mockImplementation(upstreamFetch);
        network.fetch.mockClear();
      }
    });
    it("lists without upstream access, discovers tools/resources, calls and reads text/blob", async () => {
      const f = await setup();
      expect(await listMcpConnectors(actor)).toContainEqual({
        key: f.connector.key,
        name: f.connector.name,
        capabilities: ["mcp"],
      });
      expect((await listConnectors(actor)).find((c) => c.key === f.connector.key)).toMatchObject({
        capabilities: ["mcp"],
      });
      expect((await listConnections(actor)).find((c) => c.id === f.connection.id)).toMatchObject({
        capabilities: ["mcp"],
      });
      expect(network.fetch).not.toHaveBeenCalled();
      expect(await f.call("tools")).toMatchObject({
        tools: [{ name: "fixture.read" }, { name: "fixture.write" }],
      });
      expect(await f.call("resources")).toMatchObject({
        resources: [{ uri: "fixture:///report.txt" }, { uri: "fixture:///bytes.bin" }],
      });
      expect(
        await f.call("call", {
          name: "fixture.read",
          arguments: { key: "private-argument-sentinel" },
        }),
      ).toMatchObject({ structuredContent: { key: "private-argument-sentinel" } });
      expect(await f.call("read-resource", { uri: "fixture:///bytes.bin" })).toMatchObject({
        contents: [{ blob: "AAECAw==" }],
      });
      const audits = JSON.stringify(await db.auditEvent.findMany({ where: { requestId: prefix } }));
      expect(audits).not.toContain("private-argument-sentinel");
      expect(audits).not.toContain(accessToken);
      expect(audits).not.toContain(credentials.refreshToken);
      expect(audits).toContain("mcp.tool_call.succeeded");
    });
    it("enforces owner, connector match, READY status and live connector disable with warm catalogs", async () => {
      const f = await setup(),
        other = await setup();
      await f.call("tools");
      await other.call("tools");
      const before = network.fetch.mock.calls.length;
      await expect(f.call("tools", {}, { ...actor, id: "not-owner" })).rejects.toThrow();
      await expect(f.call("tools", { connection: other.connection.id })).rejects.toThrow();
      await db.connection.update({
        where: { id: f.connection.id },
        data: { status: "RECONNECT_REQUIRED" },
      });
      await expect(f.call("tools")).rejects.toThrow();
      await db.connector.update({ where: { id: other.connector.id }, data: { enabled: false } });
      await expect(other.call("tools")).rejects.toThrow();
      expect(network.fetch).toHaveBeenCalledTimes(before);
    });
    it.each([
      ["connection", false],
      ["connector", false],
      ["connection", true],
      ["connector", true],
    ] as const)("rechecks %s versions before tools/call (warm cache: %s)", async (target, warm) => {
      const f = await setup();
      if (warm) await f.call("tools");
      const forward = network.fetch.getMockImplementation()!;
      let changed = false;
      network.fetch.mockImplementation(async (url, init) => {
        const response = await forward(url, init);
        if (
          typeof init?.body === "string" &&
          JSON.parse(init.body).method === (warm ? "initialize" : "tools/list") &&
          !changed
        ) {
          changed = true;
          if (target === "connection")
            await db.connection.update({
              where: { id: f.connection.id },
              data: { version: { increment: 1 } },
            });
          else
            await db.connector.update({
              where: { id: f.connector.id },
              data: { enabled: false, version: { increment: 1 } },
            });
        }
        return response;
      });
      const before = upstream.effects;
      try {
        await expect(f.call("call", { name: "fixture.write", arguments: {} })).rejects.toThrow();
      } finally {
        network.fetch.mockImplementation(forward);
      }
      expect(upstream.effects).toBe(before);
    });
    it.each(["http-error", "drop-after-dispatch"] as const)(
      "never replays tools/call after %s",
      async (kind) => {
        const f = await setup();
        await f.call("tools");
        const previous = upstream;
        upstream = await startMcpFixture({ fault: { method: "tools/call", kind, status: 401 } });
        try {
          await expect(f.call("call", { name: "fixture.write", arguments: {} })).rejects.toThrow();
          expect(
            upstream.requests.filter(
              (r) => r.message && "method" in r.message && r.message.method === "tools/call",
            ),
          ).toHaveLength(1);
          expect(upstream.effects).toBe(kind === "drop-after-dispatch" ? 1 : 0);
        } finally {
          await upstream.close();
          upstream = previous;
        }
      },
    );
    it("uses request quota even with a warm catalog", async () => {
      const f = await setup();
      await f.call("tools");
      await db.connection.update({
        where: { id: f.connection.id },
        data: { rateWindow: new Date(), rateCount: 60 },
      });
      const before = network.fetch.mock.calls.length;
      await expect(f.call("tools")).rejects.toMatchObject({ code: "rate_limit" });
      expect(network.fetch).toHaveBeenCalledTimes(before);
    });
    it("avoids warm discovery sessions and repeated tools/list, retaining quotas, audits and safe timings", async () => {
      const f = await setup(createMemoryMcpToolCache());
      const log = vi.spyOn(logger, "info");
      const count = (method: string) =>
        upstream.requests.filter(
          (r) => r.message && "method" in r.message && r.message.method === method,
        ).length;
      const initializations = count("initialize");
      const lists = count("tools/list");
      try {
        await f.call("tools");
        expect(count("initialize") - initializations).toBe(1);
        expect(count("tools/list") - lists).toBe(2);
        const before = network.fetch.mock.calls.length;
        await f.call("tools");
        expect(network.fetch).toHaveBeenCalledTimes(before);
        await f.call("call", {
          name: "fixture.read",
          arguments: { key: "private-cache-argument" },
        });
        expect(count("initialize") - initializations).toBe(2);
        expect(count("tools/list") - lists).toBe(2);
        await expect(f.call("call", { name: "not.present", arguments: {} })).rejects.toMatchObject({
          code: "tool_unavailable",
        });
        expect(count("initialize") - initializations).toBe(2);
        const row = await db.connection.findUniqueOrThrow({ where: { id: f.connection.id } });
        expect(row.requestCount).toBe(4);
        expect(row.rateCount).toBe(4);
        expect(
          await db.auditEvent.count({
            where: { subjectId: row.id, eventType: "connector.request" },
          }),
        ).toBe(4);
        const records = log.mock.calls.map(([fields]) => fields);
        expect(records).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: "mcp.tool_catalog.load",
              initializationMs: expect.any(Number),
              discoveryMs: expect.any(Number),
            }),
            expect.objectContaining({
              event: "mcp.operation",
              operation: "tools",
              cacheStatus: "hit",
              authorizationMs: expect.any(Number),
              cacheWaitMs: expect.any(Number),
            }),
            expect.objectContaining({
              event: "mcp.operation",
              operation: "call",
              cacheStatus: "hit",
              initializationMs: expect.any(Number),
              invocationMs: expect.any(Number),
            }),
          ]),
        );
        const serialized = JSON.stringify(records);
        for (const secret of [accessToken, credentials.refreshToken, "private-cache-argument"])
          expect(serialized).not.toContain(secret);
      } finally {
        log.mockRestore();
      }
    });
    it("invalidates catalogs on configuration versions and isolates connections", async () => {
      const cache = createMemoryMcpToolCache();
      const f = await setup(cache);
      await f.call("tools");
      const other = await setup(cache);
      const before = network.fetch.mock.calls.length;
      await other.call("tools");
      expect(network.fetch.mock.calls.length).toBeGreaterThan(before);
      const current = await db.connector.findUniqueOrThrow({
        where: { id: f.connector.id },
        include: { requiredScopes: { include: { scope: true } } },
      });
      await transaction((tx) =>
        saveConnectorConfiguration({
          tx,
          id: current.id,
          expectedVersion: current.version,
          value: { ...buildConnectorState(current), name: "Updated MCP" },
          actor,
        }),
      );
      const changed = network.fetch.mock.calls.length;
      await f.call("tools");
      expect(network.fetch.mock.calls.length).toBeGreaterThan(changed);
      const warm = network.fetch.mock.calls.length;
      await f.call("tools");
      expect(network.fetch).toHaveBeenCalledTimes(warm);
    });
    it("coalesces real discovery while independently cancelling the initiating caller", async () => {
      const cache = createMemoryMcpToolCache();
      let started!: () => void;
      const loading = new Promise<void>((resolve) => {
        started = resolve;
      });
      let joined!: () => void;
      const coalesced = new Promise<void>((resolve) => {
        joined = resolve;
      });
      const f = await setup({
        getOrLoad: (input) =>
          cache.getOrLoad({
            ...input,
            onStatus: (status) => {
              input.onStatus(status);
              if (status === "miss") started();
              if (status === "coalesced") joined();
            },
          }),
      });
      const previous = upstream;
      upstream = await startMcpFixture({ delayMethod: "tools/list", delayMs: 250 });
      try {
        const controller = new AbortController();
        const first = Promise.allSettled([f.call("tools", {}, actor, controller.signal)]);
        // Authorization updates use repeatable-read transactions; overlap discovery, not those writes.
        await Promise.race([
          loading,
          first.then(() => {
            throw new Error("Discovery did not start");
          }),
        ]);
        const second = Promise.allSettled([f.call("tools")]);
        await Promise.race([
          coalesced,
          second.then(() => {
            throw new Error("Discovery did not coalesce");
          }),
        ]);
        controller.abort();
        expect(await first).toMatchObject([{ status: "rejected", reason: { code: "cancelled" } }]);
        expect(await second).toMatchObject([
          { status: "fulfilled", value: { tools: expect.any(Array) } },
        ]);
        expect(
          upstream.requests.filter(
            (r) => r.message && "method" in r.message && r.message.method === "initialize",
          ),
        ).toHaveLength(1);
        const before = network.fetch.mock.calls.length;
        await f.call("tools");
        expect(network.fetch).toHaveBeenCalledTimes(before);
      } finally {
        await upstream.close();
        upstream = previous;
      }
    });
    it.each([
      "leaked-credential",
      "oversized",
      "duplicate",
      "pagination",
      "invalid-result",
      "http-error",
    ] as const)(
      "never publishes %s discovery, including partially collected catalogs",
      async (fault) => {
        const f = await setup(createMemoryMcpToolCache());
        const options: FixtureOptions =
          fault === "leaked-credential"
            ? { tools: [{ ...fixtureTools[0]!, description: accessToken }] }
            : fault === "oversized"
              ? { tools: [{ ...fixtureTools[0]!, description: "x".repeat(16 * 1024 + 1) }] }
              : fault === "duplicate"
                ? { tools: [fixtureTools[0]!, fixtureTools[0]!] }
                : fault === "pagination"
                  ? { repeatCursor: true }
                  : { fault: { method: "tools/list", kind: fault, status: 401 } };
        const previous = upstream;
        upstream = await startMcpFixture(options);
        try {
          await expect(f.call("tools")).rejects.toThrow();
          await expect(f.call("tools")).rejects.toThrow();
          expect(
            upstream.requests.filter(
              (r) => r.message && "method" in r.message && r.message.method === "initialize",
            ),
          ).toHaveLength(2);
        } finally {
          await upstream.close();
          upstream = previous;
        }
      },
    );
    it("does not serve expired catalogs after an upstream failure", async () => {
      let now = 0;
      const f = await setup(createMemoryMcpToolCache({ now: () => now, ttlMs: 100 }));
      await f.call("tools");
      now = 100;
      const previous = upstream;
      upstream = await startMcpFixture({
        fault: { method: "tools/list", kind: "http-error", status: 503 },
      });
      try {
        await expect(f.call("tools")).rejects.toThrow();
        await expect(f.call("call", { name: "fixture.write", arguments: {} })).rejects.toThrow();
        expect(upstream.effects).toBe(0);
        expect(
          upstream.requests.filter(
            (r) => r.message && "method" in r.message && r.message.method === "initialize",
          ),
        ).toHaveLength(2);
      } finally {
        await upstream.close();
        upstream = previous;
      }
    });
    it("creates reusable registration lazily, coordinates competing workers and never reclaims ambiguous state", async () => {
      const f = await setup();
      const register = vi.mocked(registerAtlassianMcpClient);
      register.mockClear();
      const callback = "https://weldall.example.com/api/connectors/atlassian-mcp/callback";
      const results = await Promise.allSettled([
        ensureConnectorRegistration(f.connector, callback),
        ensureConnectorRegistration(f.connector, callback),
      ]);
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);
      expect(register).toHaveBeenCalledOnce();
      expect(await ensureConnectorRegistration(f.connector, callback)).toEqual({
        clientId: "fixture-public-client",
      });
      expect(register).toHaveBeenCalledOnce();
      await expect(
        ensureConnectorRegistration(f.connector, `${callback}/changed`),
      ).rejects.toThrow();
      const failed = await setup();
      register.mockRejectedValueOnce(new Error("ambiguous POST"));
      await expect(ensureConnectorRegistration(failed.connector, callback)).rejects.toThrow();
      await expect(ensureConnectorRegistration(failed.connector, callback)).rejects.toMatchObject({
        code: "registration_unavailable",
      });
      expect(register).toHaveBeenCalledTimes(2);
    });
    it("audits normalized MCP dependencies on skill creation, dependency-only updates and deletion", async () => {
      const mutationActor = { ...actor, type: "user" as const, source: "admin_api" as const };
      const fields = {
        title: "Audited MCP skill",
        content: "# Audited MCP skill",
        requiredScopes: [],
        visibility: "DEFAULT" as const,
      };
      const before = [{ connectorKey: prefix, tools: ["read", "write"], includeResources: false }];
      const after = [{ connectorKey: prefix, tools: ["write"], includeResources: true }];
      const skill = await transaction((tx) =>
        mutateSkill(
          tx,
          {
            action: "create",
            slug: `${prefix}-audit`,
            ...fields,
            mcpDependencies: [{ ...before[0]!, tools: ["write", "read", "read"] }],
          },
          mutationActor,
        ),
      );
      const updated = await transaction((tx) =>
        mutateSkill(
          tx,
          {
            action: "update",
            id: skill.id,
            expectedVersion: skill.version,
            ...fields,
            mcpDependencies: after,
          },
          mutationActor,
        ),
      );
      await transaction((tx) =>
        mutateSkill(
          tx,
          { action: "delete", id: updated.id, expectedVersion: updated.version },
          mutationActor,
        ),
      );
      const events = await db.auditEvent.findMany({ where: { subjectId: skill.id } });
      expect(events).toHaveLength(3);
      expect(events.find((event) => event.eventType === "skill.created")?.metadata).toMatchObject({
        mcpDependencies: before,
      });
      expect(events.find((event) => event.eventType === "skill.updated")?.metadata).toMatchObject({
        before: { mcpDependencies: before },
        after: { mcpDependencies: after },
      });
      expect(events.find((event) => event.eventType === "skill.deleted")?.metadata).toMatchObject({
        mcpDependencies: after,
      });
    });
    it("applies and removes the connector/skill graph atomically without OAuth work", async () => {
      await ensureSystemScopes(db, actor.id);
      const systemScopes = await db.scope.findMany({
        where: { key: { in: ["weldall:iac", "weldall:administer"] } },
      });
      await db.emailScopeAssignment.deleteMany({ where: { normalizedEmail: actor.email } });
      await db.emailScopeAssignment.create({
        data: {
          normalizedEmail: actor.email,
          createdBy: actor.id,
          updatedBy: actor.id,
          grants: {
            create: [
              {
                scopeId: systemScopes.find((s) => s.key === "weldall:administer")!.id,
                createdBy: actor.id,
              },
              { scopeId: "scope-weldall-login", createdBy: actor.id },
            ],
          },
        },
      });
      const keys = await generateEs256KeyPair();
      const thumbprint = await calculateJwkThumbprint(keys.publicJwk);
      await db.machineClient.create({
        data: {
          clientId: actor.id,
          name: "MCP IaC test",
          createdBy: actor.id,
          updatedBy: actor.id,
          keys: {
            create: { kid: "current", publicJwk: keys.publicJwk, thumbprint, createdBy: actor.id },
          },
          allowedScopes: {
            create: { scopeId: systemScopes.find((s) => s.key === "weldall:iac")!.id },
          },
        },
      });
      const iacActor = {
        clientId: actor.id,
        keyId: "current",
        keyThumbprint: thumbprint,
        requestId: prefix,
      };
      const key = `${prefix}-iac`;
      const workspace = { id: randomUUID(), name: prefix, issuer: "https://weldall.example.com" };
      const manifest = {
        apiVersion: "weldall.dev/v1",
        workspace,
        connectors: {
          upstream: {
            key,
            name: "MCP",
            type: "atlassian-mcp",
            enabled: true,
            envelopeProvider: "LOCAL_ENV",
            requiredScopes: [],
            provider: {
              allowedScopes: ["read:jira:agent-interface"],
              defaultScopes: ["read:jira:agent-interface"],
            },
          },
        },
        skills: {
          review: {
            slug: key,
            title: "Review",
            content: "# Review",
            visibility: "DEFAULT",
            requiredScopes: [],
            mcpDependencies: [
              { connectorKey: key, tools: ["fixture.read"], includeResources: false },
            ],
          },
        },
      };
      const apply = async (manifest: unknown) => {
        const plan = await planIac(manifest);
        expect(plan.blockers).toEqual([]);
        return applyIac(
          {
            manifest,
            plannedRevision: plan.revision,
            configDigest: plan.configDigest,
            planDigest: plan.digest,
            operationId: randomUUID(),
          },
          iacActor,
        );
      };
      const registrations = vi.mocked(registerAtlassianMcpClient).mock.calls.length;
      await apply(manifest);
      expect(JSON.stringify(await getIacState(workspace.id))).toContain("connector.upstream");
      expect((await planIac(manifest)).actions.every((a) => a.action === "noop")).toBe(true);
      expect((await planIac({ ...manifest, connectors: {} })).blockers.length).toBeGreaterThan(0);
      const moved = {
        ...manifest,
        connectors: {
          upstream: { ...manifest.connectors.upstream, enabled: false },
          next: { ...manifest.connectors.upstream, key: `${key}-next` },
        },
        skills: {
          review: {
            ...manifest.skills.review,
            mcpDependencies: [
              { connectorKey: `${key}-next`, tools: ["fixture.read"], includeResources: false },
            ],
          },
        },
      };
      await apply(moved);
      expect((await db.connector.findUniqueOrThrow({ where: { key } })).enabled).toBe(false);
      expect((await planIac(moved)).actions.every((a) => a.action === "noop")).toBe(true);
      await apply(manifest);
      expect(await db.connector.count({ where: { key: `${key}-next` } })).toBe(0);
      const replacement = {
        ...manifest,
        connectors: { upstream: { ...manifest.connectors.upstream, key: `${key}-new` } },
        skills: {
          review: {
            ...manifest.skills.review,
            mcpDependencies: [
              { connectorKey: `${key}-new`, tools: ["fixture.read"], includeResources: false },
            ],
          },
        },
      };
      await apply(replacement);
      expect(await db.connector.count({ where: { key } })).toBe(0);
      await apply({
        ...replacement,
        connectors: { upstream: { ...replacement.connectors.upstream, enabled: false } },
        skills: {},
      });
      expect((await db.connector.findUniqueOrThrow({ where: { key: `${key}-new` } })).enabled).toBe(
        false,
      );
      await apply({ apiVersion: "weldall.dev/v1", workspace });
      expect(await db.connector.count({ where: { key: `${key}-new` } })).toBe(0);
      expect(await db.skill.count({ where: { slug: key } })).toBe(0);
      expect(vi.mocked(registerAtlassianMcpClient).mock.calls.length).toBe(registrations);
    });
    it.each(["disable", "noop"] as const)(
      "allows a connector %s during a DNS outage",
      async (operation) => {
        const f = await setup();
        const resolve = vi.mocked(resolvePublicIpv4);
        resolve.mockClear();
        resolve.mockRejectedValue(new Error("DNS outage"));
        try {
          const current = await db.connector.findUniqueOrThrow({
            where: { id: f.connector.id },
            include: { requiredScopes: { include: { scope: true } } },
          });
          const row = await transaction((tx) =>
            saveConnectorConfiguration({
              tx,
              id: current.id,
              expectedVersion: current.version,
              value: { ...buildConnectorState(current), enabled: operation === "noop" },
              actor,
            }),
          );
          expect(row.enabled).toBe(operation === "noop");
          expect(row.version).toBe(current.version + (operation === "disable" ? 1 : 0));
          expect(resolve).not.toHaveBeenCalled();
          if (operation === "noop") {
            const before = network.fetch.mock.calls.length;
            await expect(f.call("tools")).rejects.toThrow("DNS outage");
            expect(network.fetch).toHaveBeenCalledTimes(before);
          }
        } finally {
          resolve.mockResolvedValue("93.184.216.34");
        }
      },
    );
    it("blocks disabling or deleting a connector used by a skill", async () => {
      const f = await setup();
      const skill = await db.skill.create({
        data: {
          slug: f.connector.key,
          title: "MCP test",
          content: "test",
          mcpDependencies: [
            { connectorKey: f.connector.key, tools: ["fixture.read"], includeResources: false },
          ],
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      try {
        const current = await db.connector.findUniqueOrThrow({
          where: { id: f.connector.id },
          include: { requiredScopes: { include: { scope: true } } },
        });
        await expect(
          transaction((tx) =>
            saveConnectorConfiguration({
              tx,
              id: current.id,
              expectedVersion: current.version,
              value: { ...buildConnectorState(current), enabled: false },
              actor,
            }),
          ),
        ).rejects.toMatchObject({ code: "in_use" });
        await expect(
          transaction((tx) =>
            deleteConnectorConfiguration({
              tx,
              id: current.id,
              version: current.version,
              actor,
            }),
          ),
        ).rejects.toMatchObject({ code: "in_use" });
      } finally {
        await db.skill.delete({ where: { id: skill.id } });
      }
    });
  },
);
