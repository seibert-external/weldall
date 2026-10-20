import { escapeMcpAppText } from "@weldall/sdk/mcp/server";

export function renderExpensesUi(data: {
  requestedBy: string;
  identityType: string;
  expenses: { description: string; amount: number; currency: string }[];
}): string {
  return `<main class="expenses">
    <header><p class="eyebrow">Weldall · Native MCP</p><h1>Expenses</h1>
      <p>A read-only view served directly by the Expenses resource.</p></header>
    <section aria-label="Verified caller"><h2>Requested by</h2>
      <p>${escapeMcpAppText(data.requestedBy)} <span class="badge">${escapeMcpAppText(data.identityType)}</span></p></section>
    <table><caption>Current demo expenses</caption>
      <thead><tr><th scope="col">Description</th><th scope="col">Amount</th></tr></thead>
      <tbody>${data.expenses.map((expense) => `<tr><td>${escapeMcpAppText(expense.description)}</td><td>${escapeMcpAppText(expense.amount.toFixed(2))} ${escapeMcpAppText(expense.currency)}</td></tr>`).join("")}</tbody>
    </table>
    <footer>Demo data · Nothing is persisted. Display-only view · Supports resizing, fullscreen and PiP. No forms or tool-call buttons.</footer>
  </main>`;
}

// Public, non-sensitive asset. The HTML and caller data still require authenticated MCP reads.
export const expensesUiCss = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; background: light-dark(#f8fafc, #111827); color: light-dark(#172033, #e5e7eb); }
.expenses { max-width: 48rem; margin: 0 auto; padding: 1.5rem; }
h1 { font-size: 1.75rem; margin: .3rem 0; }
h2 { font-size: .85rem; margin: 0; }
p { line-height: 1.5; }
.eyebrow { color: light-dark(#4338ca, #a5b4fc); font-size: .75rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
section { margin: 1.5rem 0; padding: 1rem; border: 1px solid light-dark(#cbd5e1, #475569); border-radius: .75rem; }
section p { margin-bottom: 0; overflow-wrap: anywhere; }
.badge { font-size: .75rem; padding: .2rem .5rem; border-radius: .4rem; background: light-dark(#e0e7ff, #312e81); }
table { border-collapse: collapse; width: 100%; }
caption { text-align: left; font-weight: 600; padding-bottom: .75rem; }
th, td { text-align: left; padding: .75rem; border-bottom: 1px solid light-dark(#cbd5e1, #475569); }
th:last-child, td:last-child { text-align: right; white-space: nowrap; }
footer { margin-top: 1.5rem; font-size: .8rem; line-height: 1.5; color: light-dark(#475569, #cbd5e1); }
`;
