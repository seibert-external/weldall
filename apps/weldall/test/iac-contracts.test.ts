import { describe, expect, it } from "vitest";
import {
  applyRequestSchema,
  canonicalJson,
  digest,
  parseDesiredState,
} from "../src/server/iac/contracts";
import { createPlan } from "../src/server/iac/planner";
import { PrimitiveMutationError } from "../src/server/domain/primitive-mutations";

const manifest = () =>
  parseDesiredState({
    apiVersion: "weldall.dev/v1alpha1",
    workspace: {
      id: "67ade6dc-0000-4000-8000-000000000000",
      name: "platform",
      issuer: "https://weldall.example.com",
    },
    scopes: { read: { key: "expenses:read", description: "Read expenses" } },
  });

describe("native YAML IaC contracts", () => {
  it("canonicalizes object keys and set relations deterministically", () => {
    expect(canonicalJson({ z: ["b", "a"], a: 1 })).toBe('{"a":1,"z":["b","a"]}');
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
  });

  it("rejects private JWK material and machine-only human grants", () => {
    expect(() =>
      parseDesiredState({
        apiVersion: "weldall.dev/v1alpha1",
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
    expect(() =>
      parseDesiredState({
        apiVersion: "weldall.dev/v1alpha1",
        workspace: { id: crypto.randomUUID(), name: "x", issuer: "https://weldall.example.com" },
        emailAssignments: { alice: { email: "alice@example.com", scopes: ["weldall:iac"] } },
      }),
    ).toThrow(/machine-only/);
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

  it("uses key summaries and never JWK coordinates in plan actions", () => {
    const desired = parseDesiredState({
      ...manifest(),
      scopes: {},
      machines: {
        runner: {
          clientId: "runner",
          name: "Runner",
          enabled: true,
          publicKeys: { next: { kty: "EC", crv: "P-256", x: "next-x", y: "next-y" } },
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

  it("never includes desired machine key coordinates in canonical plan JSON", () => {
    const desired = parseDesiredState({
      ...manifest(),
      scopes: {},
      machines: {
        runner: {
          clientId: "runner",
          name: "Runner",
          enabled: true,
          publicKeys: { ci: { kty: "EC", crv: "P-256", x: "coordinate-x", y: "coordinate-y" } },
          resources: [],
          scopes: ["weldall:iac"],
        },
      },
    });
    const output = JSON.stringify(createPlan(desired, { revision: 0, objects: [] }));
    expect(output).not.toContain("coordinate-x");
    expect(output).not.toContain("coordinate-y");
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
          requestPrefixes: [],
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
