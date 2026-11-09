import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, Prisma } from "@weldall/db";

const mocks = vi.hoisted(() => ({ authenticateCliApiRequest: vi.fn() }));
vi.mock("../src/server/oauth/cli-api.js", () => ({
  authenticateCliApiRequest: mocks.authenticateCliApiRequest,
}));

import { GET as getCli } from "../src/app/api/me/cli/route.js";
import { GET as getPolicy } from "../src/app/api/me/policy/route.js";
import { createGroupProvider, type AdminActor } from "../src/server/group-providers/service.js";
import {
  mutateGroupAssignment,
  mutateScope,
  type MutationActor,
} from "../src/server/domain/primitive-mutations.js";
import { policyEtag } from "../src/server/policy/client-policy.js";
import { effectivePolicyFor } from "../src/server/policy/resources.js";

const runId = randomUUID().replaceAll("-", "");
const email = `client-policy-${runId}@example.com`;
const outsider = `client-policy-outsider-${runId}@example.com`;
const providerKey = `cpolicy-${runId}`;
const brokenProviderKey = `cpolicy-${runId}-broken`;
const scopeKey = `cpolicy-${runId}:read`;
const actor: AdminActor = {
  id: `client-policy-actor-${runId}`,
  email: `actor-${runId}@example.com`,
  requestId: `client-policy-${runId}`,
};
const machine: MutationActor = {
  type: "machine",
  id: actor.id,
  requestId: actor.requestId,
  source: "weldall_up",
};
let previousSettings: { appendix: string; policy: unknown } | null = null;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const assign = (key: string, groupId: string, policy?: unknown) =>
  db.$transaction((tx) =>
    mutateGroupAssignment(
      tx,
      {
        action: "create",
        providerKey: key,
        groupId,
        scopeKeys: [scopeKey],
        policy: policy as never,
      },
      machine,
    ),
  );

async function withBrokenProvider(run: () => Promise<void>) {
  await createGroupProvider(
    {
      key: brokenProviderKey,
      name: "Broken provider",
      adapterType: "management-api-v1",
      baseUrl: `https://broken-${runId}.example.com`,
      token: "token",
      enabled: true,
    },
    actor,
  );
  await assign(brokenProviderKey, "anything", { version: 1, approvalMode: "auto" });
  try {
    await run();
  } finally {
    await db.groupScopeAssignment.deleteMany({ where: { provider: { key: brokenProviderKey } } });
    await db.groupProvider.deleteMany({ where: { key: brokenProviderKey } });
  }
}

const request = (path: string) => new Request(`https://weldall.example.com${path}`);
const signIn = (as: string) =>
  mocks.authenticateCliApiRequest.mockResolvedValue({ id: "user", email: as, name: "User" });

beforeAll(async () => {
  process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith(`https://broken-${runId}.example.com`)) throw new Error("connect failed");
    if (url.includes("/api/management/users/?mail=")) {
      const mail = new URL(url).searchParams.get("mail") ?? "";
      return json(mail === email ? [{ username: "alice", email: mail, is_active: true }] : []);
    }
    if (url.endsWith("/api/management/users/alice/"))
      return json({ username: "alice", email, is_active: true, groups: ["finance", "dev"] });
    return new Response(null, { status: 404 });
  });

  const settings = await db.cliSettings.findUniqueOrThrow({ where: { id: "default" } });
  previousSettings = { appendix: settings.appendix, policy: settings.policy };
  await db.cliSettings.update({
    where: { id: "default" },
    data: {
      appendix: "Organisation appendix",
      policy: { version: 1, approvalMode: "smart_approve", shell: false },
    },
  });
  await db.$transaction((tx) =>
    mutateScope({
      tx,
      input: { action: "create", key: scopeKey, description: scopeKey },
      actor: machine,
    }),
  );
  await createGroupProvider(
    {
      key: providerKey,
      name: "Policy provider",
      adapterType: "management-api-v1",
      baseUrl: `https://groups-${runId}.example.com`,
      token: "token",
      enabled: true,
    },
    actor,
  );
  await assign(providerKey, "finance", {
    version: 1,
    approvalMode: "approve",
    instructions: "Finance instructions",
  });
  await assign(providerKey, "dev", {
    version: 1,
    approvalMode: "auto",
    shell: true,
    instructions: "Dev instructions",
  });
  await assign(providerKey, "sales", { version: 1, extensions: { developer: true } });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (previousSettings)
    await db.cliSettings.update({
      where: { id: "default" },
      data: {
        appendix: previousSettings.appendix,
        policy: (previousSettings.policy ?? Prisma.DbNull) as Prisma.InputJsonValue,
      },
    });
  await db.groupScopeAssignment.deleteMany({
    where: { provider: { key: { startsWith: providerKey } } },
  });
  await db.groupProvider.deleteMany({ where: { key: { startsWith: providerKey } } });
  await db.auditEvent.deleteMany({ where: { actorId: actor.id } });
  await db.scope.deleteMany({ where: { key: scopeKey } });
});

describe("effective client policy", () => {
  it("merges the default and the caller's groups in provider-key, group-id order", async () => {
    const { policy, unavailableGroupProviders } = await effectivePolicyFor(email);
    expect(unavailableGroupProviders).toEqual([]);
    expect(policy).toEqual({
      version: 1,
      approvalMode: "auto",
      shell: true,
      instructions: "Dev instructions\n\nFinance instructions",
    });
  });

  it("ignores policies of groups the caller is not in", async () => {
    const { policy } = await effectivePolicyFor(email);
    expect(policy.extensions).toBeUndefined();
  });

  it("returns the default policy for a user without groups", async () => {
    const { policy } = await effectivePolicyFor(outsider);
    expect(policy).toEqual({ version: 1, approvalMode: "smart_approve", shell: false });
  });

  it("reports an unavailable provider", async () => {
    await withBrokenProvider(async () => {
      const { unavailableGroupProviders } = await effectivePolicyFor(email);
      expect(unavailableGroupProviders.map(({ key }) => key)).toEqual([brokenProviderKey]);
    });
  });
});

describe("GET /api/me/policy", () => {
  it("serves the policy without instructions and no-store", async () => {
    signIn(email);
    const response = await getPolicy(request("/api/me/policy"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.version).toBe(1);
    expect(body.policy).toEqual({ version: 1, approvalMode: "auto", shell: true });
    expect(body.etag).toBe(policyEtag(body.policy));
    expect(typeof body.updatedAt).toBe("string");
  });

  it("answers 503 while a group provider is unavailable", async () => {
    signIn(email);
    await withBrokenProvider(async () => {
      const response = await getPolicy(request("/api/me/policy"));
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "group_provider_unavailable" });
    });
  });
});

describe("GET /api/me/cli", () => {
  it("appends the caller's group instructions to the appendix", async () => {
    signIn(email);
    const body = await (await getCli(request("/api/me/cli"))).json();
    expect(body.appendix).toBe("Organisation appendix\n\nDev instructions\n\nFinance instructions");
  });

  it("serves the default appendix to a user without group instructions", async () => {
    signIn(outsider);
    const body = await (await getCli(request("/api/me/cli"))).json();
    expect(body.appendix).toBe("Organisation appendix");
  });

  it("serves the default appendix while a group provider is unavailable", async () => {
    signIn(email);
    await withBrokenProvider(async () => {
      const response = await getCli(request("/api/me/cli"));
      expect(response.status).toBe(200);
      expect((await response.json()).appendix).toBe("Organisation appendix");
    });
  });
});
