import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listVisibleSkills: vi.fn(),
  getVisibleSkill: vi.fn(),
  recordSkillRetrievalEvent: vi.fn(),
  delegatedResourceRequest: vi.fn(),
  resourceRegistryFor: vi.fn(),
}));

vi.mock("../src/server/skills/service", () => ({
  listVisibleSkills: mocks.listVisibleSkills,
  getVisibleSkill: mocks.getVisibleSkill,
}));
vi.mock("../src/server/policy/resources", () => ({
  resourceRegistryFor: mocks.resourceRegistryFor,
}));
vi.mock("../src/server/skills/retrieval-metrics", () => ({
  recordSkillRetrievalEvent: mocks.recordSkillRetrievalEvent,
}));
vi.mock("../src/server/ai/delegated-resource", () => ({
  delegatedResourceRequest: mocks.delegatedResourceRequest,
}));

import { createChatTools } from "../src/server/ai/tools";

const principal = { id: "user-1", email: "user@example.com", name: "Example User" };
const requestIdentifiers = { requestId: "request-1" };
const executionOptions = {
  toolCallId: "call-1",
  messages: [],
  context: undefined,
};

const expenseSkill = {
  slug: "expenses.review",
  title: "Review expenses",
  preview: "List and review submitted expenses",
  requiredScopes: ["expenses:read", "expenses:create"],
  visibility: "DEFAULT" as const,
  available: true,
  missingScopes: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
  meta: { tags: ["finance"] },
  source: { type: "resource" as const, key: "expenses", name: "Expenses" },
};

function tools() {
  return createChatTools({ principal, requestIdentifiers });
}

describe("chat tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordSkillRetrievalEvent.mockResolvedValue(undefined);
    mocks.resourceRegistryFor.mockResolvedValue([
      {
        key: "expenses",
        name: "Expenses",
        requestPrefixes: ["https://expenses.example/api"],
        grantedScopes: ["expenses:read", "expenses:create"],
      },
    ]);
  });

  it("searches the scope-filtered skill catalog", async () => {
    mocks.listVisibleSkills.mockResolvedValue({
      items: [
        expenseSkill,
        {
          ...expenseSkill,
          slug: "people.lookup",
          title: "Find employees",
          preview: "Search the employee directory",
          requiredScopes: ["people:read"],
          meta: { tags: ["directory"] },
          source: { type: "resource", key: "people", name: "People" },
        },
      ],
      warnings: [],
    });

    const result = await tools().searchSkills.execute!(
      { query: "finance expenses", limit: 5 },
      executionOptions,
    );

    expect(result).toEqual({
      skills: [
        expect.objectContaining({
          slug: "expenses.review",
          title: "Review expenses",
          available: true,
          source: { type: "resource", key: "expenses", name: "Expenses" },
        }),
      ],
      warnings: [],
    });
  });

  it("loads a skill with its currently allowed request prefixes", async () => {
    mocks.getVisibleSkill.mockResolvedValue({
      ...expenseSkill,
      document: "# Review expenses\n\nUse `weldall request https://expenses.example/api/expenses`.",
      content: "Review expenses",
      involvedResources: [{ key: "expenses", name: "Expenses" }],
    });

    const result = await tools().getSkill.execute!({ slug: "expenses.review" }, executionOptions);

    expect(result).toEqual(
      expect.objectContaining({
        slug: "expenses.review",
        resources: [
          {
            key: "expenses",
            name: "Expenses",
            requestPrefixes: ["https://expenses.example/api"],
            grantedScopes: ["expenses:read", "expenses:create"],
          },
        ],
      }),
    );
  });

  it("binds resource requests to an available loaded skill", async () => {
    mocks.getVisibleSkill.mockResolvedValue({
      ...expenseSkill,
      document: "# Review expenses\n\nUse `weldall request https://expenses.example/api/expenses`.",
      content: "Review expenses",
      involvedResources: [{ key: "expenses", name: "Expenses" }],
    });
    mocks.delegatedResourceRequest.mockResolvedValue({ status: 201, ok: true, data: { id: "1" } });

    await tools().weldallRequest.execute!(
      {
        skillSlug: "expenses.review",
        url: "https://expenses.example/api/expenses",
        method: "POST",
        scopes: ["expenses:create"],
        json: { amount: 24 },
      },
      executionOptions,
    );

    expect(mocks.delegatedResourceRequest).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({
        method: "POST",
        scopes: ["expenses:create"],
        allowedResourceKeys: ["expenses"],
        toolCallId: "call-1",
      }),
    );
  });

  it("rejects sibling paths and query changes not documented by the skill", async () => {
    mocks.getVisibleSkill.mockResolvedValue({
      ...expenseSkill,
      document:
        "# Review expenses\n\nUse `weldall request https://expenses.example/api/expenses?owner=self`.",
      content: "Review expenses",
      involvedResources: [{ key: "expenses", name: "Expenses" }],
    });

    await expect(
      tools().weldallRequest.execute!(
        {
          skillSlug: "expenses.review",
          url: "https://expenses.example/api/expenses/admin",
          method: "GET",
          scopes: ["expenses:read"],
        },
        executionOptions,
      ),
    ).rejects.toThrow("does not document this exact request URL");
    await expect(
      tools().weldallRequest.execute!(
        {
          skillSlug: "expenses.review",
          url: "https://expenses.example/api/expenses?owner=all",
          method: "GET",
          scopes: ["expenses:read"],
        },
        executionOptions,
      ),
    ).rejects.toThrow("does not document this exact request URL");
    expect(mocks.delegatedResourceRequest).not.toHaveBeenCalled();
  });
});
