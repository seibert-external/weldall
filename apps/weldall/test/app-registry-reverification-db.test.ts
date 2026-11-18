import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ADMIN_SCOPE_KEY,
  APP_REGISTRY_READ_SCOPE_KEY,
  db,
  ensureSystemScopes,
  SUBJECT_SCOPES_CHECK_SCOPE_KEY,
} from "@weldall/db";
import {
  createDpopProof,
  generateEs256KeyPair,
  requestMachineToken,
  type DpopKeyPair,
} from "@weldall/sdk";

const mocks = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string } | null,
}));
vi.mock("../src/server/oauth/cli-api", async () => {
  const { WeldallAuthError } = await import("@weldall/sdk");
  return {
    authenticateCliApiRequest: vi.fn(async () => {
      if (!mocks.user) throw new WeldallAuthError("invalid_token", "missing", 401);
      return mocks.user;
    }),
  };
});
vi.mock("../src/server/auth/auth.js", () => ({
  auth: { handler: vi.fn(async () => new Response(null, { status: 500 })) },
}));
import { GET as listMine } from "../src/app/api/me/apps/route";
import { POST as confirm } from "../src/app/api/me/apps/[id]/confirm/route";
import { appRegistryApi } from "../src/server/app-registry/machine-api";
import {
  APP_REVERIFICATION_DAYS,
  createApp,
  updateAppLinks,
} from "../src/server/app-registry/service";
import { WELDALL_ISSUER, WELDALL_RESOURCE } from "../src/server/oauth/constants";
import type { TrpcContext } from "../src/server/trpc/context";
import { appRouter } from "../src/server/trpc/router";

const target = "postgresql://postgres@localhost:5433/postgres";
// Use the operator-approved local database or CI's existing disposable test service; never reset either here.
const approvedTarget =
  process.env.POSTGRES_URL === target ||
  /^postgresql:\/\/postgres@localhost:5433\/weldall_connector_test_[a-f0-9]{32}$/.test(
    process.env.POSTGRES_URL ?? "",
  ) ||
  (process.env.CI === "true" &&
    process.env.POSTGRES_URL === "postgresql://postgres:postgres@localhost:5432/postgres");
const prefix = `appreverify-${randomUUID()}`;
const DAY = 24 * 60 * 60 * 1000;
const person = (name: string) => ({
  id: `${prefix}-${name}`,
  email: `${prefix}-${name}@example.com`,
  name: `${name} ${prefix}`,
});
const alice = person("alice");
const bob = person("bob");
const admin = person("admin");
const readerClientId = `${prefix}-reader`;
const otherClientId = `${prefix}-other`;
const registryUrl = `${WELDALL_ISSUER}/api/app-registry/v1/apps`;
let connectorId: string;
let readerKey: DpopKeyPair;
let otherKey: DpopKeyPair;
/** Alice's apps: active, expiring soon, expired; bob's: one active. */
const ids: Record<"active" | "soon" | "expired" | "bobs", string> = {
  active: "",
  soon: "",
  expired: "",
  bobs: "",
};

const meRequest = (path: string, method = "GET") =>
  new Request(`${WELDALL_ISSUER}/api/me/${path}`, {
    method,
    headers: { authorization: "DPoP test" },
  });
async function confirmAs(user: typeof alice, appId: string) {
  mocks.user = user;
  const response = await confirm(meRequest(`apps/${appId}/confirm`, "POST"), {
    params: Promise.resolve({ id: appId }),
  });
  return { status: response.status, json: (await response.json()) as any };
}
const caller = (userId: string) =>
  appRouter.createCaller({
    request: new Request(`${WELDALL_ISSUER}/api/trpc`),
    requestId: randomUUID(),
    session: { user: { id: userId } } as TrpcContext["session"],
  });

async function facadeFetch(input: string | URL | Request, init?: RequestInit) {
  const request = input instanceof Request ? input : new Request(input, init);
  const { tokenFacade } = await import("../src/server/oauth/facade.js");
  return tokenFacade(request);
}
const machineToken = async (clientId: string, key: DpopKeyPair, scope: string) =>
  (
    await requestMachineToken({
      issuer: WELDALL_ISSUER,
      clientId,
      resource: WELDALL_RESOURCE,
      scopes: [scope],
      kid: "current",
      key,
      fetch: facadeFetch,
    })
  ).accessToken;
async function readRegistry(token: string, key: DpopKeyPair, query = "") {
  const url = `${registryUrl}${query}`;
  const proof = await createDpopProof({ ...key, method: "GET", url, accessToken: token });
  const response = await appRegistryApi(
    new Request(url, { headers: { authorization: `DPoP ${token}`, dpop: proof } }),
  );
  return { status: response.status, json: (await response.json()) as any };
}

describe.skipIf(!approvedTarget)(
  "app re-verification, admin list and machine API on explicitly selected disposable PostgreSQL",
  () => {
    beforeAll(async () => {
      if (!approvedTarget) throw new Error("Unsafe database target");
      const issuerKey = await generateEs256KeyPair();
      [readerKey, otherKey] = await Promise.all([generateEs256KeyPair(), generateEs256KeyPair()]);
      Object.assign(process.env, {
        WELDALL_SIGNING_PRIVATE_JWK: JSON.stringify(issuerKey.privateJwk),
        WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(issuerKey.publicJwk),
        WELDALL_SIGNING_KID: `${prefix}-signing`,
      });
      await ensureSystemScopes(db, prefix);
      const scope = (key: string) => db.scope.findUniqueOrThrow({ where: { key } });
      const [login, administer, registryRead, subjectCheck] = await Promise.all([
        scope("weldall:login"),
        scope(ADMIN_SCOPE_KEY),
        scope(APP_REGISTRY_READ_SCOPE_KEY),
        scope(SUBJECT_SCOPES_CHECK_SCOPE_KEY),
      ]);
      for (const [user, scopes] of [
        [alice, [login]],
        [bob, [login]],
        [admin, [login, administer]],
      ] as const) {
        await db.user.create({
          data: { id: user.id, email: user.email, name: user.name, emailVerified: true },
        });
        await db.emailScopeAssignment.create({
          data: {
            normalizedEmail: user.email,
            createdBy: prefix,
            updatedBy: prefix,
            grants: { create: scopes.map(({ id }) => ({ scopeId: id, createdBy: prefix })) },
          },
        });
      }
      connectorId = (
        await db.connector.create({
          data: {
            key: `${prefix}-github`,
            name: "GitHub",
            providerType: "github-app",
            enabled: false,
            envelopeProvider: "LOCAL_ENV",
            providerConfig: {
              appId: "123456",
              organization: "acme-apps",
              installationId: "987654",
              apiBaseUrl: "https://api.github.com",
              templates: [{ name: "react", repository: "acme-apps/react-starter" }],
              repositoryNamePrefix: "app-",
              reviewerTeam: "app-reviewers",
              setupMode: "customer-managed",
            },
            createdBy: prefix,
            updatedBy: prefix,
          },
        })
      ).id;
      const now = Date.now();
      const register = async (
        name: string,
        ownerId: string,
        expiresInDays: number,
        createdAt: Date,
      ) => {
        const app = await createApp({
          name,
          purpose: `${name} <script>alert(1)</script>`,
          ownerId,
          repository: { connectorId, owner: "acme-apps", name: `app-${name}` },
          defaultBranch: "main",
          template: { name: "react", commit: "a".repeat(40) },
        });
        await db.app.update({
          where: { id: app.id },
          data: {
            createdAt,
            expiresAt: new Date(now + expiresInDays * DAY),
            previewUrl: "javascript:alert(1)",
            liveUrl: `https://${name}.example.com/`,
          },
        });
        return app.id;
      };
      // Fixed creation times far in the past so these apps come first in the machine API's order.
      const base = new Date("2001-01-01T00:00:00.000Z").getTime();
      ids.active = await register("active", alice.id, 60, new Date(base));
      ids.soon = await register("soon", alice.id, 5, new Date(base + 1_000));
      ids.expired = await register("expired", alice.id, -2, new Date(base + 2_000));
      ids.bobs = await register("bobs", bob.id, 61, new Date(base + 2_000));

      const { createMachineClient } = await import("../src/server/machines/service.js");
      for (const [clientId, key, scopeIds] of [
        [readerClientId, readerKey, [registryRead.id]],
        [otherClientId, otherKey, [subjectCheck.id]],
      ] as const)
        await createMachineClient(
          {
            clientId,
            name: clientId,
            key: { kid: "current", publicJwk: key.publicJwk },
            access: { resourceIds: [], scopeIds: [...scopeIds] },
          },
          { id: prefix, requestId: `${prefix}-machine` },
        );
    });

    afterEach(() => {
      mocks.user = null;
    });

    afterAll(async () => {
      if (!approvedTarget) return;
      await db.app.deleteMany({ where: { ownerId: { startsWith: prefix } } });
      await db.connector.deleteMany({ where: { key: { startsWith: prefix } } });
      await db.machineClient.deleteMany({ where: { clientId: { startsWith: prefix } } });
      await db.emailScopeAssignment.deleteMany({
        where: { normalizedEmail: { startsWith: prefix } },
      });
      await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
      await db.auditEvent.deleteMany({
        where: {
          OR: [
            { actorId: { startsWith: prefix } },
            { clientId: { startsWith: prefix } },
            { actorId: { in: [readerClientId, otherClientId] } },
          ],
        },
      });
    });

    it("lists only the caller's apps with the derived state, flagged ones first", async () => {
      mocks.user = alice;
      const response = await listMine(meRequest("apps"));
      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json).toMatchObject({ reverificationDays: 90, expiringSoonDays: 14 });
      expect(json.apps.map((app: any) => [app.id, app.state])).toEqual([
        [ids.expired, "expired"],
        [ids.soon, "expiring_soon"],
        [ids.active, "active"],
      ]);
      expect(json.apps[2]).toEqual({
        id: ids.active,
        name: "active",
        purpose: "active <script>alert(1)</script>",
        repository: {
          connector: `${prefix}-github`,
          owner: "acme-apps",
          name: "app-active",
          webUrl: "https://github.com/acme-apps/app-active",
        },
        template: "react",
        links: { preview: null, live: "https://active.example.com/" },
        createdAt: "2001-01-01T00:00:00.000Z",
        confirmedAt: null,
        expiresAt: expect.stringMatching(/Z$/),
        state: "active",
      });
      mocks.user = bob;
      const bobs = (await (await listMine(meRequest("apps"))).json()) as any;
      expect(bobs.apps.map((app: any) => app.id)).toEqual([ids.bobs]);
    });

    it("lets the owner confirm: the expiry moves to 90 days from now, recorded and audited", async () => {
      const before = Date.now();
      const { status, json } = await confirmAs(alice, ids.expired);
      expect(status).toBe(200);
      expect(json.app).toMatchObject({ id: ids.expired, state: "active" });
      const stored = await db.app.findUniqueOrThrow({ where: { id: ids.expired } });
      expect(stored.confirmedBy).toBe(alice.id);
      expect(stored.confirmedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(stored.expiresAt.getTime() - stored.confirmedAt!.getTime()).toBe(
        APP_REVERIFICATION_DAYS * DAY,
      );
      expect(json.app.confirmedAt).toBe(stored.confirmedAt!.toISOString());
      expect(json.app.expiresAt).toBe(stored.expiresAt.toISOString());
      const [entry] = await db.auditEvent.findMany({
        where: { actorId: alice.id, eventType: "app_confirmation.succeeded" },
      });
      expect(entry).toMatchObject({
        outcome: "success",
        actorEmail: alice.email,
        subjectType: "app",
        subjectId: ids.expired,
        metadata: {
          appId: ids.expired,
          connectorId,
          repositoryOwner: "acme-apps",
          repositoryName: "app-expired",
          expiresAt: stored.expiresAt.toISOString(),
          previousState: "expired",
        },
      });
    });

    it("never moves the expiry when the CI reports links (publishing confirms nothing)", async () => {
      const before = await db.app.findUniqueOrThrow({ where: { id: ids.soon } });
      await updateAppLinks(ids.soon, { previewUrl: "https://preview.example.com/1" });
      const after = await db.app.findUniqueOrThrow({ where: { id: ids.soon } });
      expect(after.expiresAt).toEqual(before.expiresAt);
      expect(after.confirmedAt).toBeNull();
    });

    it("answers an unknown and another person's app identically and audits both refusals", async () => {
      const bobsBefore = await db.app.findUniqueOrThrow({ where: { id: ids.bobs } });
      const foreign = await confirmAs(alice, ids.bobs);
      const unknown = await confirmAs(alice, "c0000000000000000000000000");
      const malformed = await confirmAs(alice, "../../x");
      expect(foreign).toEqual({
        status: 404,
        json: { error: "not_found", error_description: "No app of yours has this id." },
      });
      expect(unknown).toEqual(foreign);
      expect(malformed).toEqual(foreign);
      expect(await db.app.findUniqueOrThrow({ where: { id: ids.bobs } })).toEqual(bobsBefore);
      const denied = await db.auditEvent.findMany({
        where: { actorId: alice.id, eventType: "app_confirmation.denied" },
        orderBy: { occurredAt: "asc" },
      });
      expect(
        denied.map(({ outcome, subjectId, metadata }) => ({ outcome, subjectId, metadata })),
      ).toEqual([
        {
          outcome: "denied",
          subjectId: null,
          metadata: { appId: ids.bobs, reason: "No app of yours has this id." },
        },
        {
          outcome: "denied",
          subjectId: null,
          metadata: { appId: "c0000000000000000000000000", reason: "No app of yours has this id." },
        },
        {
          outcome: "denied",
          subjectId: null,
          metadata: { appId: null, reason: "No app of yours has this id." },
        },
      ]);
    });

    it("shows administrators every app with its owner, filtered and flagged ones first", async () => {
      const all = await caller(admin.id).admin.apps.list({ page: 1, pageSize: 50, q: prefix });
      expect(all.total).toBe(4);
      expect(all.items.map(({ name, state }) => [name, state])).toEqual([
        ["soon", "expiring_soon"],
        ["active", "active"],
        ["bobs", "active"],
        ["expired", "active"],
      ]);
      expect(all.items[0]).toMatchObject({
        owner: { id: alice.id, name: alice.name, email: alice.email },
        links: { preview: "https://preview.example.com/1", live: "https://soon.example.com/" },
      });
      const soon = await caller(admin.id).admin.apps.list({
        page: 1,
        pageSize: 50,
        q: `${prefix}-bob@`,
      });
      expect(soon.items.map(({ id }) => id)).toEqual([ids.bobs]);
      const expiring = await caller(admin.id).admin.apps.list({
        page: 1,
        pageSize: 50,
        q: prefix,
        state: "expiring_soon",
      });
      expect(expiring.items.map(({ id }) => id)).toEqual([ids.soon]);
      await expect(
        caller(alice.id).admin.apps.list({ page: 1, pageSize: 50 }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("serves the registry to a machine client with the scope, page by page", async () => {
      const token = await machineToken(readerClientId, readerKey, APP_REGISTRY_READ_SCOPE_KEY);
      const seen: any[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const { status, json } = await readRegistry(token, readerKey, query);
        expect(status).toBe(200);
        expect(json.apps.length).toBeLessThanOrEqual(2);
        expect(json).toMatchObject({ reverificationDays: 90, expiringSoonDays: 14 });
        seen.push(...json.apps);
        cursor = json.nextCursor;
        pages++;
      } while (cursor && pages < 1_000);
      expect(new Set(seen.map(({ id }) => id)).size).toBe(seen.length);
      const ordered = [...seen].sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      expect(seen.map(({ id }) => id)).toEqual(ordered.map(({ id }) => id));
      const mine = seen.filter(({ owner }) => owner.id.startsWith(prefix));
      expect(mine.map(({ id }) => id)).toEqual([
        ids.active,
        ids.soon,
        ...[ids.expired, ids.bobs].sort(),
      ]);
      expect(mine.find(({ id }) => id === ids.bobs)).toEqual({
        id: ids.bobs,
        name: "bobs",
        purpose: "bobs <script>alert(1)</script>",
        owner: { id: bob.id, email: bob.email },
        repository: {
          connector: `${prefix}-github`,
          owner: "acme-apps",
          name: "app-bobs",
          webUrl: "https://github.com/acme-apps/app-bobs",
        },
        template: "react",
        links: { preview: null, live: "https://bobs.example.com/" },
        createdAt: "2001-01-01T00:00:02.000Z",
        confirmedAt: null,
        expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        state: "active",
      });

      const expiring = await readRegistry(token, readerKey, "?state=expiring_soon&limit=200");
      expect(expiring.json.apps.every(({ state }: any) => state === "expiring_soon")).toBe(true);
      expect(expiring.json.apps.map(({ id }: any) => id)).toContain(ids.soon);

      for (const query of [
        "?limit=0",
        "?limit=201",
        "?state=paused",
        "?cursor=bm9wZQ",
        "?x=1",
        "?limit=1&limit=2",
      ])
        expect(await readRegistry(token, readerKey, query)).toMatchObject({
          status: 400,
          json: { error: "invalid_request" },
        });
    });

    it("denies a machine without the scope and callers without a machine token", async () => {
      await expect(
        machineToken(otherClientId, otherKey, APP_REGISTRY_READ_SCOPE_KEY),
      ).rejects.toMatchObject({ code: "invalid_scope" });
      const other = await machineToken(otherClientId, otherKey, SUBJECT_SCOPES_CHECK_SCOPE_KEY);
      expect(await readRegistry(other, otherKey)).toMatchObject({
        status: 403,
        json: { error: "insufficient_scope" },
      });
      const anonymous = await appRegistryApi(new Request(registryUrl));
      expect(anonymous.status).toBe(401);
      const person = await appRegistryApi(
        new Request(registryUrl, { headers: { authorization: "DPoP test", dpop: "x" } }),
      );
      expect(person.status).toBe(401);
    });
  },
);
