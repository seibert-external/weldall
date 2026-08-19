import { describe, expect, it } from "vitest";
import { MACHINE_ONLY_SYSTEM_SCOPE_KEYS } from "@weldall/db";
import { generateEs256KeyPair } from "@weldall/sdk";
import {
  applyRequestSchema,
  canonicalJson,
  digest,
  importRequestSchema,
  moveRequestSchema,
  parseDesiredState,
  unmanageRequestSchema,
} from "../src/server/iac/contracts";
import { createPlan } from "../src/server/iac/planner";
import { PrimitiveMutationError } from "../src/server/domain/primitive-mutations";

const manifest = () =>
  parseDesiredState({
    apiVersion: "weldall.dev/v1",
    workspace: {
      id: "67ade6dc-0000-4000-8000-000000000000",
      name: "platform",
      issuer: "https://weldall.example.com",
    },
    scopes: { read: { key: "expenses:read", description: "Read expenses" } },
  });

describe("native YAML IaC contracts", () => {
  it("plans canonical CLI logo updates and preserves an empty value", () => {
    const desired = parseDesiredState({
      ...manifest(),
      cli: { logoUrl: "" },
    });
    expect(desired.cli?.logoUrl).toBe("");
    const plan = createPlan(desired, {
      revision: 1,
      objects: [],
      cliSettings: { logoUrl: "https://example.com/old.svg", version: 4 },
    });
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          address: "cli.default",
          kind: "cli",
          action: "update",
          observedVersion: 4,
        }),
      ]),
    );
    expect(() =>
      parseDesiredState({ ...manifest(), cli: { logoUrl: "http://example.com/logo.svg" } }),
    ).toThrow();
  });

  it("canonicalizes object keys and set relations deterministically", () => {
    expect(canonicalJson({ z: ["b", "a"], a: 1 })).toBe('{"a":1,"z":["b","a"]}');
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
  });

  it("canonicalizes skills and keeps Markdown out of plan actions", () => {
    const desired = parseDesiredState({
      ...manifest(),
      skills: {
        review: {
          slug: "expenses.review",
          title: "Review expenses",
          content: "# Private operating instructions",
          requiredScopes: ["expenses:write", "expenses:read", "expenses:read"],
          visibility: "HIDDEN_IF_UNALLOWED",
        },
      },
    });
    expect(desired.skills.review?.requiredScopes).toEqual(["expenses:read", "expenses:write"]);
    const plan = createPlan(desired, { revision: 0, objects: [] });
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ address: "skill.review", kind: "skill", action: "create" }),
      ]),
    );
    expect(JSON.stringify(plan)).not.toContain("Private operating instructions");
    expect(
      digest(
        parseDesiredState({
          apiVersion: "weldall.dev/v1",
          workspace: {
            id: "67ade6dc-0000-4000-8000-000000000000",
            name: "platform",
            issuer: "https://weldall.example.com",
          },
          skills: {
            review: {
              slug: "expenses.review",
              title: "Review",
              content: "# Review",
              requiredScopes: ["expenses:write", "expenses:read"],
              visibility: "DEFAULT",
            },
          },
        }),
      ),
    ).toBe("990a499264dbf19bde564967075d9abaa74fbcdffec75d1141fdecf723607ff3");
    expect(() =>
      parseDesiredState({
        ...manifest(),
        skills: {
          bad: {
            slug: "Bad slug",
            title: "Bad",
            content: " ",
            requiredScopes: [],
            visibility: "PUBLIC",
          },
        },
      }),
    ).toThrow();
  });

  it("uses slug replacement semantics and requires import for manual collisions", () => {
    const desired = parseDesiredState({
      ...manifest(),
      scopes: {},
      skills: {
        review: {
          slug: "expenses.review",
          title: "Review expenses",
          content: "# Review",
          requiredScopes: [],
          visibility: "DEFAULT",
        },
      },
    });
    const bound = {
      address: "skill.review",
      kind: "skill" as const,
      id: "old",
      identity: "expenses.old",
      version: 1,
      ownerWorkspaceId: desired.workspace.id,
      state: {
        ...desired.skills.review,
        slug: "expenses.old",
      },
    };
    expect(createPlan(desired, { revision: 1, objects: [bound] }).actions[0]).toMatchObject({
      action: "replace",
      kind: "skill",
    });
    const collision = { ...bound, address: undefined, id: "manual", identity: "expenses.review" };
    const blocked = createPlan(desired, { revision: 1, objects: [collision] });
    expect(blocked.blockers[0]).toMatchObject({ code: "MANUAL_COLLISION" });
  });

  it("blocks a live skill collision before recreating a tombstoned binding", () => {
    const desired = parseDesiredState({
      ...manifest(),
      scopes: {},
      skills: {
        review: {
          slug: "expenses.review",
          title: "Review expenses",
          content: "# Review",
          requiredScopes: [],
          visibility: "DEFAULT",
        },
      },
    });
    const tombstone = {
      address: "skill.review",
      kind: "skill" as const,
      id: "binding",
      identity: "expenses.review",
      version: 0,
      ownerWorkspaceId: desired.workspace.id,
      state: null,
      tombstone: true,
    };
    for (const collision of [
      {
        kind: "skill" as const,
        id: "manual",
        identity: "expenses.review",
        version: 1,
        state: desired.skills.review,
      },
      {
        address: "skill.other",
        kind: "skill" as const,
        id: "other",
        identity: "expenses.review",
        version: 2,
        ownerWorkspaceId: "67ade6dc-0000-4000-8000-000000000001",
        state: desired.skills.review,
      },
    ]) {
      const plan = createPlan(desired, { revision: 2, objects: [collision, tombstone] });
      expect(plan.actions).toEqual([]);
      expect(plan.blockers).toEqual([
        expect.objectContaining({
          address: "skill.review",
          code: collision.ownerWorkspaceId ? "OWNED_BY_OTHER_WORKSPACE" : "MANUAL_COLLISION",
        }),
      ]);
    }
  });

  it("includes observed object versions in the canonical plan contract", () => {
    const desired = manifest();
    const current = {
      address: "scope.read",
      kind: "scope" as const,
      id: "managed",
      identity: "expenses:read",
      version: 4,
      ownerWorkspaceId: desired.workspace.id,
      state: { key: "expenses:read", description: "Admin-edited" },
    };
    const first = createPlan(desired, { revision: 3, objects: [current] });
    const second = createPlan(desired, {
      revision: 3,
      objects: [{ ...current, version: current.version + 1 }],
    });

    expect(first.actions).toEqual([
      expect.objectContaining({
        address: "scope.read",
        action: "update",
        observedVersion: 4,
      }),
    ]);
    expect(first.digest).toBe("bfde721857f189ea2f4404433c1aff5859abfb48a89d91690d2eb812199f6e15");
    expect(first.digest).not.toBe(second.digest);
    expect(JSON.stringify(first)).not.toContain("Admin-edited");
  });

  it("accepts provider group IDs up to the persistence limit", () => {
    const desired = {
      apiVersion: "weldall.dev/v1",
      workspace: { id: crypto.randomUUID(), name: "x", issuer: "https://weldall.example.com" },
      groupAssignments: {
        staged: { provider: "directory", groupId: "g".repeat(191), scopes: ["expenses:read"] },
      },
    };
    expect(parseDesiredState(desired).groupAssignments.staged?.groupId).toHaveLength(191);
    expect(() =>
      parseDesiredState({
        ...desired,
        groupAssignments: {
          staged: { ...desired.groupAssignments.staged, groupId: "g".repeat(192) },
        },
      }),
    ).toThrow();
  });

  it("rejects private JWK material and machine-only human grants", () => {
    expect(() =>
      parseDesiredState({
        apiVersion: "weldall.dev/v1",
        workspace: { id: crypto.randomUUID(), name: "x", issuer: "https://weldall.example.com" },
        machines: {
          runner: {
            clientId: "runner",
            name: "Runner",
            enabled: true,
            publicKeys: { key: { kty: "EC", crv: "P-256", x: "x", y: "y", d: "secret" } },
            resources: [],
            scopes: ["weldall:iac"],
          },
        },
      }),
    ).toThrow();
    for (const scope of MACHINE_ONLY_SYSTEM_SCOPE_KEYS) {
      expect(() =>
        parseDesiredState({
          apiVersion: "weldall.dev/v1",
          workspace: {
            id: crypto.randomUUID(),
            name: "x",
            issuer: "https://weldall.example.com",
          },
          emailAssignments: { alice: { email: "alice@example.com", scopes: [scope] } },
        }),
      ).toThrow(/machine-only/);
    }
  });

  it("scopes logical addresses to the current workspace while collisions remain global", () => {
    const desired = manifest();
    const plan = createPlan(desired, {
      revision: 2,
      objects: [
        {
          address: "scope.read",
          kind: "scope",
          id: "other",
          identity: "other:read",
          version: 1,
          ownerWorkspaceId: "67ade6dc-0000-4000-8000-000000000001",
          state: { key: "other:read", description: "Other workspace" },
        },
        {
          address: "scope.different_address",
          kind: "scope",
          id: "collision",
          identity: "expenses:read",
          version: 1,
          ownerWorkspaceId: "67ade6dc-0000-4000-8000-000000000001",
          state: { key: "expenses:read", description: "Owned elsewhere" },
        },
      ],
    });
    expect(plan.actions).toEqual([]);
    expect(plan.blockers).toEqual([
      expect.objectContaining({
        code: "OWNED_BY_OTHER_WORKSPACE",
        address: "scope.read",
      }),
    ]);
  });

  it("leaves manual omissions alone and blocks natural-key collisions", () => {
    const plan = createPlan(manifest(), {
      revision: 0,
      objects: [
        {
          kind: "scope",
          id: "manual",
          identity: "expenses:read",
          version: 1,
          state: { key: "expenses:read", description: "manual" },
        },
      ],
    });
    expect(plan.actions).toEqual([]);
    expect(plan.blockers[0]).toMatchObject({ code: "MANUAL_COLLISION", address: "scope.read" });
  });

  it("uses key summaries and never JWK coordinates in plan actions", async () => {
    const nextKey = (await generateEs256KeyPair()).publicJwk;
    const desired = parseDesiredState({
      ...manifest(),
      scopes: {},
      machines: {
        runner: {
          clientId: "runner",
          name: "Runner",
          enabled: true,
          publicKeys: { next: nextKey },
          resources: [],
          scopes: ["weldall:iac"],
        },
      },
    });
    const plan = createPlan(desired, {
      revision: 1,
      objects: [
        {
          address: "machine.runner",
          kind: "machine",
          id: "runner",
          identity: "runner",
          version: 1,
          ownerWorkspaceId: desired.workspace.id,
          state: {
            clientId: "runner",
            name: "Runner",
            enabled: true,
            publicKeys: { old: { kty: "EC", crv: "P-256", x: "old-x", y: "old-y" } },
            resources: [],
            scopes: ["weldall:iac"],
          },
        },
      ],
    });
    expect(plan.actions.map(({ action }) => action)).toEqual([
      "register_key",
      "update",
      "revoke_key",
    ]);
    expect(JSON.stringify(plan.actions)).not.toMatch(/next-x|old-x|\"x\"|\"y\"/);
    expect(plan.actions[0]).toMatchObject({ keyId: "next", keyThumbprint: expect.any(String) });
    expect(plan.actions[2]).toMatchObject({ keyId: "old", irreversible: true });
  });

  it("keeps primitive failures bounded and free of JWK coordinates", () => {
    const error = new PrimitiveMutationError("CONFLICT", "Key ID old is immutable.", {
      currentVersion: 2,
    });
    expect(JSON.stringify(error)).not.toMatch(/"d"|"x"|"y"|manifest|private/i);
    expect(error.details).toEqual({ currentVersion: 2 });
  });

  it("never includes desired machine key coordinates in canonical plan JSON", async () => {
    const publicJwk = (await generateEs256KeyPair()).publicJwk;
    const desired = parseDesiredState({
      ...manifest(),
      scopes: {},
      machines: {
        runner: {
          clientId: "runner",
          name: "Runner",
          enabled: true,
          publicKeys: { ci: publicJwk },
          resources: [],
          scopes: ["weldall:iac"],
        },
      },
    });
    const output = JSON.stringify(createPlan(desired, { revision: 0, objects: [] }));
    expect(output).not.toContain(publicJwk.x);
    expect(output).not.toContain(publicJwk.y);
  });

  it("rejects unknown and unbounded apply request fields", () => {
    expect(() => applyRequestSchema.parse({ extra: true })).toThrow();
    expect(() =>
      applyRequestSchema.parse({
        manifest: manifest(),
        plannedRevision: 0,
        configDigest: "x".repeat(64),
        planDigest: "a".repeat(64),
        operationId: crypto.randomUUID(),
      }),
    ).toThrow();
  });

  it("plans immutable resource identifiers as replacement", () => {
    const desired = parseDesiredState({
      ...manifest(),
      scopes: {},
      resources: {
        api: {
          key: "api",
          name: "API",
          resourceIdentifier: "https://new.example/api",
          authorizationServer: "https://auth.example",
          downstreamClientId: "api",
          enabled: true,
          skillDiscoveryEnabled: false,
          requestPrefixes: ["https://new.example/api"],
          scopes: [],
        },
      },
    });
    const plan = createPlan(desired, {
      revision: 1,
      objects: [
        {
          address: "resource.api",
          kind: "resource",
          id: "api",
          identity: "api",
          version: 1,
          ownerWorkspaceId: desired.workspace.id,
          state: { ...desired.resources.api, resourceIdentifier: "https://old.example/api" },
        },
      ],
    });
    expect(plan.actions[0]).toMatchObject({ action: "replace" });
  });

  it("refines import addresses to the exact kind prefix at the API schema", () => {
    const workspace = manifest().workspace;
    const base = {
      workspace,
      identity: "expenses:read",
      operationId: crypto.randomUUID(),
    };
    expect(
      importRequestSchema.parse({ ...base, kind: "scope", address: "scope.expenses_read" }),
    ).toMatchObject({ kind: "scope", address: "scope.expenses_read" });
    expect(() =>
      importRequestSchema.parse({ ...base, kind: "scope", address: "resource.expenses_read" }),
    ).toThrow(/exact primitive kind prefix/);
    expect(() =>
      importRequestSchema.parse({ ...base, kind: "emailAssignment", address: "email.person" }),
    ).toThrow();
  });

  it("blocks replacement when the desired natural key already exists", () => {
    const desired = manifest();
    const current = {
      address: "scope.read",
      kind: "scope" as const,
      id: "owned",
      identity: "expenses:old",
      version: 1,
      ownerWorkspaceId: desired.workspace.id,
      state: { key: "expenses:old", description: "Old" },
    };
    for (const collision of [
      {
        kind: "scope" as const,
        id: "manual",
        identity: "expenses:read",
        version: 1,
        state: { key: "expenses:read", description: "Manual" },
      },
      {
        address: "scope.other",
        kind: "scope" as const,
        id: "other",
        identity: "expenses:read",
        version: 1,
        ownerWorkspaceId: "67ade6dc-0000-4000-8000-000000000001",
        state: { key: "expenses:read", description: "Other" },
      },
    ]) {
      const plan = createPlan(desired, { revision: 1, objects: [current, collision] });
      expect(plan.actions).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ action: "replace" })]),
      );
      expect(plan.blockers).toEqual([
        expect.objectContaining({
          address: "scope.read",
          code: collision.ownerWorkspaceId ? "OWNED_BY_OTHER_WORKSPACE" : "MANUAL_COLLISION",
        }),
      ]);
    }
  });

  it("requires a canonical desired snapshot for unmanage", () => {
    const desired = manifest();
    const request = {
      workspaceId: desired.workspace.id,
      address: "scope.read",
      manifest: desired,
      configDigest: digest(desired),
      operationId: crypto.randomUUID(),
    };
    expect(unmanageRequestSchema.parse(request)).toMatchObject(request);
    const canonicalDefaults = parseDesiredState({
      apiVersion: "weldall.dev/v1",
      workspace: desired.workspace,
      resources: {
        api: {
          key: "api",
          name: "API",
          resourceIdentifier: "https://api.example.com/v1",
          authorizationServer: "https://auth.example.com",
          downstreamClientId: "api",
          enabled: true,
          requestPrefixes: ["https://api.example.com/v2", "https://api.example.com/v1"],
          scopes: ["expenses:write", "expenses:read"],
        },
      },
    });
    expect(digest(canonicalDefaults)).toBe(
      "c2e1311af97134bca5534c104566d7efa1d873bc61d3ff8f71f2ddf3caa6a054",
    );
    expect(() =>
      unmanageRequestSchema.parse({
        workspaceId: desired.workspace.id,
        address: "scope.read",
        operationId: crypto.randomUUID(),
      }),
    ).toThrow();
  });

  it("rejects empty service relations, noncanonical URLs, and cross-kind state moves", () => {
    expect(() =>
      parseDesiredState({
        apiVersion: "weldall.dev/v1",
        workspace: { id: crypto.randomUUID(), name: "x", issuer: "https://weldall.example.com" },
        resources: {
          api: {
            key: "api",
            name: "API",
            resourceIdentifier: "https://api.example.com/v1",
            authorizationServer: "https://auth.example.com/path",
            downstreamClientId: "api",
            enabled: true,
            requestPrefixes: [],
            scopes: [],
          },
        },
      }),
    ).toThrow();
    expect(() =>
      moveRequestSchema.parse({
        workspaceId: crypto.randomUUID(),
        from: "scope.old",
        to: "resource.new",
        operationId: crypto.randomUUID(),
      }),
    ).toThrow(/same primitive kind/);
  });

  it("plans drift restoration, tombstone recreation, and owned deletion", () => {
    const desired = manifest();
    const drift = createPlan(desired, {
      revision: 3,
      objects: [
        {
          address: "scope.read",
          kind: "scope",
          id: "owned",
          identity: "expenses:read",
          version: 2,
          ownerWorkspaceId: desired.workspace.id,
          state: { key: "expenses:read", description: "changed" },
        },
        {
          address: "scope.old",
          kind: "scope",
          id: "old",
          identity: "expenses:old",
          version: 1,
          ownerWorkspaceId: desired.workspace.id,
          state: {},
        },
      ],
    });
    expect(drift.actions.map(({ address, action }) => [address, action])).toEqual([
      ["scope.read", "update"],
      ["scope.old", "delete"],
    ]);
    const tombstone = createPlan(desired, {
      revision: 4,
      objects: [
        {
          address: "scope.read",
          kind: "scope",
          id: "binding",
          identity: "expenses:read",
          version: 0,
          ownerWorkspaceId: desired.workspace.id,
          state: null,
          tombstone: true,
        },
      ],
    });
    expect(tombstone.actions[0]).toMatchObject({ action: "recreate", drift: true });
  });
});
