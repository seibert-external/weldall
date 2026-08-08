import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapAdmin } from "../src/server/admin/service.js";
import { bootstrapConfiguredAdmin } from "../src/server/deployment.js";

const findFirst = vi.fn();
const prisma = {
  emailScopeGrant: { findFirst },
} as unknown as PrismaClient;

const bootstrap = vi.fn<typeof bootstrapAdmin>(
  async (email) =>
    ({
      email,
      scopes: ["weldall:administer", "weldall:login"],
    }) as Awaited<ReturnType<typeof bootstrapAdmin>>,
);

beforeEach(() => {
  findFirst.mockReset();
  bootstrap.mockReset();
  bootstrap.mockImplementation(
    async (email) =>
      ({
        email,
        scopes: ["weldall:administer", "weldall:login"],
      }) as Awaited<ReturnType<typeof bootstrapAdmin>>,
  );
});

describe("configured administrator deployment bootstrap", () => {
  it("bootstraps both protected scopes when no administrator exists", async () => {
    findFirst.mockResolvedValue(null);

    const assignment = await bootstrapConfiguredAdmin("fresh@example.com", prisma, bootstrap);

    expect(assignment?.scopes).toEqual(["weldall:administer", "weldall:login"]);
    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it("does not restore login for an existing admin-only assignment", async () => {
    findFirst.mockResolvedValue({ id: "existing-admin-grant" });
    const existingScopes = ["weldall:administer"];
    bootstrap.mockImplementation(async (email) => {
      existingScopes.push("weldall:login");
      return {
        email,
        scopes: existingScopes,
      } as Awaited<ReturnType<typeof bootstrapAdmin>>;
    });

    await expect(
      bootstrapConfiguredAdmin("existing@example.com", prisma, bootstrap),
    ).resolves.toBeNull();

    expect(existingScopes).toEqual(["weldall:administer"]);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("is a no-op when an administrator already has both scopes", async () => {
    findFirst.mockResolvedValue({ id: "existing-admin-grant" });
    const existingScopes = ["weldall:administer", "weldall:login"];
    bootstrap.mockImplementation(async (email) => {
      existingScopes.push("weldall:login");
      return {
        email,
        scopes: existingScopes,
      } as Awaited<ReturnType<typeof bootstrapAdmin>>;
    });

    await expect(
      bootstrapConfiguredAdmin("existing@example.com", prisma, bootstrap),
    ).resolves.toBeNull();

    expect(existingScopes).toEqual(["weldall:administer", "weldall:login"]);
    expect(bootstrap).not.toHaveBeenCalled();
  });
});
