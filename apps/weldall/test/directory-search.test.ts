import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  effectiveScopesFor: vi.fn(),
  findResources: vi.fn(),
  findScopes: vi.fn(),
  listVisibleSkillsForScopes: vi.fn(),
}));

vi.mock("@weldall/db", () => ({
  db: {
    downstreamResource: { findMany: mocks.findResources },
    scope: { findMany: mocks.findScopes },
  },
}));
vi.mock("../src/server/policy/resources", () => ({
  effectiveScopesFor: mocks.effectiveScopesFor,
}));
vi.mock("../src/server/skills/service", () => ({
  listVisibleSkillsForScopes: mocks.listVisibleSkillsForScopes,
}));

import {
  listDirectoryResources,
  listDirectoryScopes,
  listSearchablePrimitives,
} from "../src/server/directory/search";

describe("directory primitive search", () => {
  beforeEach(() => {
    mocks.effectiveScopesFor.mockReset().mockResolvedValue(["expenses:read"]);
    mocks.listVisibleSkillsForScopes.mockReset().mockResolvedValue({
      items: [
        {
          slug: "expenses.review",
          title: "Review expenses",
          preview: "Review submitted expenses.",
          requiredScopes: ["expenses:read"],
          available: true,
          source: { type: "resource", key: "expenses", name: "Expenses" },
          meta: { tags: ["finance"], owner: "Finance" },
        },
      ],
      warnings: [],
    });
    mocks.findResources.mockReset().mockResolvedValue([
      {
        key: "expenses",
        name: "Expenses",
        resourceIdentifier: "https://expenses.example/api",
      },
    ]);
    mocks.findScopes
      .mockReset()
      .mockResolvedValue([{ key: "expenses:read", description: "Read expenses" }]);
  });

  it("loads only the safe resource directory fields", async () => {
    await expect(listDirectoryResources()).resolves.toEqual([
      {
        key: "expenses",
        name: "Expenses",
        resourceIdentifier: "https://expenses.example/api",
      },
    ]);

    expect(mocks.findResources).toHaveBeenCalledWith({
      where: { enabled: true },
      orderBy: [{ name: "asc" }, { key: "asc" }],
      select: { key: true, name: true, resourceIdentifier: true },
    });
    expect(mocks.effectiveScopesFor).not.toHaveBeenCalled();
  });

  it("loads only scopes granted to the signed-in user", async () => {
    await expect(listDirectoryScopes("user@example.com")).resolves.toEqual([
      { key: "expenses:read", description: "Read expenses" },
    ]);

    expect(mocks.effectiveScopesFor).toHaveBeenCalledWith("user@example.com");
    expect(mocks.findScopes).toHaveBeenCalledWith({
      where: { key: { in: ["expenses:read"] } },
      orderBy: { key: "asc" },
      select: { key: true, description: true },
    });
  });

  it("returns only compact searchable attributes for the signed-in user's view", async () => {
    await expect(listSearchablePrimitives("user@example.com")).resolves.toEqual([
      {
        type: "skill",
        id: "expenses.review",
        label: "Review expenses",
        description: "Review submitted expenses.",
        keywords: ["Expenses", "finance", "Finance", "expenses:read"],
        available: true,
      },
      {
        type: "resource",
        id: "expenses",
        label: "Expenses",
        description: "https://expenses.example/api",
      },
      {
        type: "scope",
        id: "expenses:read",
        label: "expenses:read",
        description: "Read expenses",
      },
    ]);

    expect(mocks.effectiveScopesFor).toHaveBeenCalledWith("user@example.com");
    expect(mocks.listVisibleSkillsForScopes).toHaveBeenCalledWith(["expenses:read"]);
    expect(mocks.findScopes).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: { in: ["expenses:read"] } } }),
    );
  });

  it("does not query scope details when the user has no grants", async () => {
    mocks.effectiveScopesFor.mockResolvedValue([]);
    mocks.listVisibleSkillsForScopes.mockResolvedValue({ items: [], warnings: [] });

    const result = await listSearchablePrimitives("user@example.com");

    expect(mocks.findScopes).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        type: "resource",
        id: "expenses",
        label: "Expenses",
        description: "https://expenses.example/api",
      },
    ]);
  });
});
