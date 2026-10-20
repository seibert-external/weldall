import { escapeMcpAppText } from "@weldall/sdk/mcp/server";

export function renderExpensesUi(data: {
  requestedBy: string;
  identityType: string;
  resourceUri?: string;
  expenses: { description: string; amount: number; currency: string }[];
}): string {
  return `<main class="expenses">
    <header><p class="eyebrow">Weldall · Native MCP</p><h1>Expenses</h1>
      <p>A resource-owned view with a simulated approval workflow.</p></header>
    <section aria-label="Verified caller"><h2>Requested by</h2>
      <p>${escapeMcpAppText(data.requestedBy)} <span class="badge">${escapeMcpAppText(data.identityType)}</span></p></section>
    <table><caption>Current demo expenses</caption>
      <thead><tr><th scope="col">Description</th><th scope="col">Amount</th></tr></thead>
      <tbody>${data.expenses.map((expense) => `<tr><td>${escapeMcpAppText(expense.description)}</td><td>${escapeMcpAppText(expense.amount.toFixed(2))} ${escapeMcpAppText(expense.currency)}</td></tr>`).join("")}</tbody>
    </table>
    <section aria-label="MCP App playground" data-expense-review="expense-1" data-resource-uri="${escapeMcpAppText(data.resourceUri ?? "expenses://current")}">
      <h2>MCP App playground</h2>
      <p data-review-status role="status" aria-live="polite">Interactive controls require a compatible Weldall host.</p>
      <pre data-action-result></pre>
      <div data-app-controls></div>
      <p data-app-events></p>
    </section>
    <footer>Demo only · Decisions are simulated, not persisted. Supports resizing, fullscreen and PiP.</footer>
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
button { font: inherit; margin: .75rem .5rem 0 0; padding: .5rem .8rem; border-radius: .4rem; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .6; }
button:focus-visible { outline: 3px solid light-dark(#4338ca, #a5b4fc); outline-offset: 2px; }
.action-group { margin: 1rem 0; }
h3 { font-size: .85rem; margin-bottom: 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 14rem; overflow: auto; font-size: .75rem; }
[data-app-events] { font-size: .75rem; color: light-dark(#475569, #cbd5e1); }
footer { margin-top: 1.5rem; font-size: .8rem; line-height: 1.5; color: light-dark(#475569, #cbd5e1); }
`;

// A public ES module. Only the authenticated HTML carries caller data.
export const expensesUiScript = `
const sdkUrl = new URL("./sdk.js", import.meta.url);
sdkUrl.search = new URL(import.meta.url).search;
const sdk = await import(sdkUrl.href);
const panel = document.querySelector("[data-expense-review]");
const status = panel.querySelector("[data-review-status]");
const output = panel.querySelector("[data-action-result]");
const controls = panel.querySelector("[data-app-controls]");
const events = panel.querySelector("[data-app-events]");
const host = await sdk.getMcpAppHost();
const caps = host.capabilities;
let preview = null;
const buttons = [];
const recentEvents = [];
const unsubscribe = sdk.subscribeMcpAppEvents(event => {
  recentEvents.push(event.method + (event.params?.displayMode ? " (" + event.params.displayMode + ")" : ""));
  if (recentEvents.length > 3) recentEvents.shift();
  events.textContent = "Host events: " + recentEvents.join(" → ");
});
window.addEventListener("pagehide", unsubscribe, { once: true });
const show = (message, data) => {
  status.textContent = message;
  output.textContent = data === undefined ? "" : JSON.stringify(data, null, 2);
};
const group = title => {
  const node = document.createElement("div");
  node.className = "action-group";
  const heading = document.createElement("h3");
  heading.textContent = title;
  node.appendChild(heading);
  controls.appendChild(node);
  return node;
};
const action = (group, label, supported, run) => {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = !supported;
  button.title = supported ? label : "Not supported by this host";
  buttons.push({ button, supported });
  button.addEventListener("click", async () => {
    buttons.forEach(({ button }) => button.disabled = true);
    show(label + "…");
    try { await run(); }
    catch (error) { show(error instanceof Error ? error.message : "Action failed."); }
    finally { buttons.forEach(({ button, supported }) => button.disabled = !supported); }
  });
  group.appendChild(button);
};
const decisions = group("1 · Tool calls — no chat message, no persistence");
for (const decision of ["approve", "deny"]) {
  action(decisions, decision === "approve" ? "Simulate approve" : "Simulate deny", Boolean(caps.serverTools), async () => {
    const result = await sdk.callMcpAppTool("preview_expense_decision", { expenseId: panel.dataset.expenseReview, decision });
    if (result.isError) throw new Error("The demo tool rejected the decision.");
    const data = result.structuredContent;
    if (!data?.simulated || data.persisted !== false || !["approve", "deny"].includes(data.decision))
      throw new Error("Unexpected demo tool response.");
    preview = data;
    show(data.decision === "approve" ? "Mock result: approved. Nothing was saved." : "Mock result: denied. Nothing was saved.", data);
  });
}
const dataActions = group("2 · Resources and chat");
action(dataActions, "List resources", Boolean(caps.serverResources), async () => {
  const result = await sdk.listMcpAppResources();
  show("Resources of this integration only.", result);
});
action(dataActions, "Read expenses", Boolean(caps.serverResources), async () => {
  const result = await sdk.readMcpAppResource({ uri: panel.dataset.resourceUri });
  const item = result.contents.find(item => item.uri === panel.dataset.resourceUri && typeof item.text === "string");
  if (!item) throw new Error("Expense data missing from resource response.");
  show("Expense data loaded through MCP, not browser fetch().", JSON.parse(item.text));
});
action(dataActions, "Set model context", Boolean(caps.updateModelContext), async () => {
  const context = { demo: "Expenses", selectedExpenseId: panel.dataset.expenseReview, preview, note: "Context button test" };
  await sdk.updateMcpAppContext({ structuredContent: context });
  show("Context set. No chat turn started. Ask the chat which expense is selected.", context);
});
action(dataActions, "Send to chat", Boolean(caps.message), async () => {
  const result = await sdk.sendMcpAppMessage({ role: "user", content: [{ type: "text", text:
    "Expenses App test: briefly summarize this demo state without calling tools. No expenses were saved. " +
    JSON.stringify({ expenseId: panel.dataset.expenseReview, preview }) }] });
  show(result.isError ? "The host declined the chat message." : "Message sent to the chat. The assistant can now respond.");
});
action(dataActions, "Sampling", Boolean(caps.sampling), async () => {
  const result = await sdk.createMcpAppSamplingMessage({ messages: [{ role: "user", content: { type: "text", text: "Say hello from the Expenses demo." } }], maxTokens: 80 });
  show("Sampling result (not a chat turn).", result);
});
const hostActions = group("3 · Host actions");
action(hostActions, "Open service metadata", Boolean(caps.openLinks), async () => {
  const result = await sdk.openMcpAppLink({ url: new URL("/.well-known/oauth-protected-resource", import.meta.url).href });
  show(result.isError ? "Link opening cancelled or declined." : "Service metadata opened in the browser.");
});
action(hostActions, "Download JSON", Boolean(caps.downloadFile), async () => {
  const result = await sdk.downloadMcpAppFile({ contents: [{ type: "resource", resource: {
    uri: "file:///expenses-demo.json", mimeType: "application/json",
    text: JSON.stringify({ demo: true, expenseId: panel.dataset.expenseReview, preview, persisted: false }, null, 2),
  } }] });
  show(result.isError ? "Download cancelled or declined." : "Demo JSON saved at the destination you selected.");
});
action(hostActions, "Write log", Boolean(caps.logging), async () => {
  await sdk.sendMcpAppLog({ level: "info", logger: "expenses-demo", data: "Log button clicked (no caller data)." });
  show("Log sent. Check the desktop renderer console for [MCP App].");
});
action(hostActions, "Host capabilities", true, async () => show("Current host capabilities and presentation context.", await sdk.getMcpAppHost()));
const display = group("4 · Display and lifecycle");
for (const [mode, label] of [["inline", "Inline"], ["fullscreen", "Fullscreen"], ["pip", "Picture in picture"]]) {
  action(display, label, host.context.availableDisplayModes?.includes(mode), async () => {
    const result = await sdk.requestMcpAppDisplayMode({ mode });
    show("Display mode: " + result.mode);
  });
}
const extra = document.createElement("div");
extra.hidden = true;
for (let i = 0; i < 6; i++) {
  const row = document.createElement("p");
  row.textContent = "Resize test row " + (i + 1) + " — the host should grow and shrink with this content.";
  extra.appendChild(row);
}
controls.appendChild(extra);
action(display, "Toggle extra content", true, async () => {
  extra.hidden = !extra.hidden;
  show(extra.hidden ? "Extra content hidden; inline view should shrink." : "Extra content shown; inline view should grow.");
});
action(display, "Close app", true, async () => {
  await sdk.requestMcpAppTeardown();
  show("Close requested. Call list_expenses again to open a fresh view.");
});
show("Ready. Each action runs only when clicked. Sampling is disabled when the host does not offer it.");
`;
