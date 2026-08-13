import { describe, expect, it } from "vitest";
import { canonicalJson, digest, parseDesiredState } from "../src/server/iac/contracts";
import { createPlan } from "../src/server/iac/planner";

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
