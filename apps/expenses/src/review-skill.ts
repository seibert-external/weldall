import type { PublishedSkill } from "@weldall/sdk";

// The served catalog and development seed use the same demo workflow.
export const reviewExpensesSkill = (origin: string) =>
  ({
    id: "review",
    title: "Review expenses",
    requiredScopes: ["expenses:read"],
    visibility: "DEFAULT",
    meta: { tags: ["expenses", "review"] },
    mcpDependencies: [{ kind: "resource", resourceKey: "expenses" }],
    content: `# Review expenses

Use the activated \`list_expenses\` tool or read \`expenses://current\` to inspect expenses visible to the verified caller. Summarize descriptions, amounts and currencies from the returned data.

This skill selects the whole \`expenses\` resource, not an account or a fixed tool list. Discovery requires \`expenses:read\`; it does not authorize writes. If activation or access is denied, explain the missing access rather than guessing another route.

\`create_expense\` requires \`expenses:create\` and an explicit user request. Do not call it as part of a read-only review. Demo writes are not persisted.

For a deliberately chosen HTTP-only workflow, use \`weldall request --scope expenses:read ${origin}/api/expenses\`. Do not automatically fall back to HTTP after a failed MCP operation or retry a write.`,
  }) satisfies PublishedSkill;
