import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { expensesUiScript, renderExpensesUi } from "../src/expenses-ui.js";

class Element {
  textContent = "";
  disabled = false;
  hidden = false;
  dataset: Record<string, string> = {};
  children: Element[] = [];
  handlers = new Map<string, () => Promise<void>>();
  constructor(readonly tagName: string) {}
  appendChild(child: Element) {
    this.children.push(child);
    return child;
  }
  addEventListener(name: string, callback: () => Promise<void>) {
    this.handlers.set(name, callback);
  }
  async click() {
    if (this.disabled) throw new Error("Button disabled");
    await this.handlers.get("click")!();
  }
}

async function fixture() {
  const panel = new Element("section");
  panel.dataset = { expenseReview: "expense-1", resourceUri: "expenses-demo://current" };
  const nodes = Object.fromEntries(
    ["data-review-status", "data-action-result", "data-app-controls", "data-app-events"].map(
      (key) => [key, new Element("div")],
    ),
  );
  Object.assign(panel, { querySelector: (selector: string) => nodes[selector.slice(1, -1)] });
  const sdk = {
    getMcpAppHost: vi.fn(async () => ({
      capabilities: {
        serverTools: {},
        serverResources: {},
        message: { text: {} },
        updateModelContext: { text: {} },
        openLinks: {},
        downloadFile: {},
        logging: {},
      },
      context: { availableDisplayModes: ["inline", "fullscreen", "pip"] },
    })),
    subscribeMcpAppEvents: vi.fn((_callback: (event: unknown) => void) => vi.fn()),
    callMcpAppTool: vi.fn(async (_name: string, args: Record<string, string>) => ({
      structuredContent: { ...args, simulated: true, persisted: false },
    })),
    listMcpAppResources: vi.fn(async () => ({
      resources: [{ uri: "expenses-demo://current", name: "Expenses" }],
    })),
    readMcpAppResource: vi.fn(async (_args: unknown) => ({
      contents: [
        {
          uri: "expenses-demo://current",
          text: JSON.stringify({ expenses: [{ id: "expense-1" }] }),
        },
      ],
    })),
    updateMcpAppContext: vi.fn(async (_args: unknown) => ({})),
    sendMcpAppMessage: vi.fn(async (_args: unknown) => ({})),
    createMcpAppSamplingMessage: vi.fn(async () => ({})),
    openMcpAppLink: vi.fn(async (_args: unknown) => ({})),
    downloadMcpAppFile: vi.fn(async (_args: unknown) => ({ isError: false })),
    sendMcpAppLog: vi.fn(async (_args: unknown) => {}),
    requestMcpAppDisplayMode: vi.fn(async (args: { mode: string }) => args),
    requestMcpAppTeardown: vi.fn(async () => {}),
  };
  const source = expensesUiScript
    .replaceAll(
      "import.meta.url",
      JSON.stringify("https://expenses.example/mcp-ui/expenses.js?v=build-hash"),
    )
    .replace("await import(sdkUrl.href)", "sdkFixture");
  const sdkUrl = await runInNewContext(`(async () => { ${source}; return sdkUrl.href; })()`, {
    sdkFixture: sdk,
    URL,
    Error,
    window: { addEventListener: vi.fn() },
    document: { querySelector: () => panel, createElement: (tag: string) => new Element(tag) },
  });
  const walk = (node: Element): Element[] => [node, ...node.children.flatMap(walk)];
  const buttons = walk(nodes["data-app-controls"]!).filter((node) => node.tagName === "button");
  const button = (label: string) => buttons.find((button) => button.textContent === label)!;
  return { sdk, nodes, buttons, button, sdkUrl, status: nodes["data-review-status"]! };
}

describe("Expenses action playground", () => {
  it("binds every action explicitly and keeps resource URIs and asset versions correct", async () => {
    const f = await fixture();
    expect(f.sdkUrl).toBe("https://expenses.example/mcp-ui/sdk.js?v=build-hash");
    expect(f.buttons).toHaveLength(16);
    expect(f.button("Sampling").disabled).toBe(true);
    expect(f.sdk.callMcpAppTool).not.toHaveBeenCalled();
    expect(f.sdk.sendMcpAppMessage).not.toHaveBeenCalled();
    expect(f.sdk.readMcpAppResource).not.toHaveBeenCalled();
    for (const [label, decision] of [
      ["Simulate approve", "approve"],
      ["Simulate deny", "deny"],
    ]) {
      await f.button(label!).click();
      expect(f.sdk.callMcpAppTool).toHaveBeenLastCalledWith("preview_expense_decision", {
        expenseId: "expense-1",
        decision,
      });
      expect(f.status.textContent).toContain("Nothing was saved.");
    }
    expect(f.sdk.sendMcpAppMessage).not.toHaveBeenCalled();
    await f.button("List resources").click();
    expect(f.sdk.listMcpAppResources).toHaveBeenCalledOnce();
    await f.button("Read expenses").click();
    expect(f.sdk.readMcpAppResource).toHaveBeenCalledWith({ uri: "expenses-demo://current" });
    await f.button("Set model context").click();
    expect(f.sdk.updateMcpAppContext).toHaveBeenCalledWith({
      structuredContent: expect.objectContaining({
        selectedExpenseId: "expense-1",
        preview: expect.objectContaining({ decision: "deny" }),
      }),
    });
    expect(f.sdk.sendMcpAppMessage).not.toHaveBeenCalled();
    await f.button("Send to chat").click();
    expect(f.sdk.sendMcpAppMessage).toHaveBeenCalledWith({
      role: "user",
      content: [{ type: "text", text: expect.stringContaining('"persisted":false') }],
    });
    await f.button("Open service metadata").click();
    expect(f.sdk.openMcpAppLink).toHaveBeenCalledWith({
      url: "https://expenses.example/.well-known/oauth-protected-resource",
    });
    await f.button("Download JSON").click();
    expect(f.sdk.downloadMcpAppFile).toHaveBeenCalledWith({
      contents: [
        {
          type: "resource",
          resource: expect.objectContaining({
            uri: "file:///expenses-demo.json",
            text: expect.stringContaining('"persisted": false'),
          }),
        },
      ],
    });
    await f.button("Write log").click();
    expect(f.sdk.sendMcpAppLog).toHaveBeenCalledOnce();
    await f.button("Host capabilities").click();
    expect(f.sdk.getMcpAppHost).toHaveBeenCalledTimes(2);
    for (const [label, mode] of [
      ["Inline", "inline"],
      ["Fullscreen", "fullscreen"],
      ["Picture in picture", "pip"],
    ]) {
      await f.button(label!).click();
      expect(f.sdk.requestMcpAppDisplayMode).toHaveBeenLastCalledWith({ mode });
    }
    await f.button("Toggle extra content").click();
    expect(f.status.textContent).toContain("should grow");
    await f.button("Toggle extra content").click();
    expect(f.status.textContent).toContain("should shrink");
    f.sdk.subscribeMcpAppEvents.mock.calls[0]![0]({
      method: "ui/notifications/tool-result",
      params: {},
    });
    expect(f.nodes["data-app-events"]!.textContent).toContain("ui/notifications/tool-result");
    await f.button("Close app").click();
    expect(f.sdk.requestMcpAppTeardown).toHaveBeenCalledOnce();
    expect(f.sdk.createMcpAppSamplingMessage).not.toHaveBeenCalled();
  });

  it("reports failures and cancellations without retrying or enabling unsupported actions", async () => {
    const f = await fixture();
    f.sdk.callMcpAppTool.mockRejectedValueOnce(new Error("Permission denied"));
    await f.button("Simulate approve").click();
    expect(f.status.textContent).toBe("Permission denied");
    expect(f.sdk.callMcpAppTool).toHaveBeenCalledOnce();
    expect(f.button("Simulate approve").disabled).toBe(false);
    expect(f.button("Sampling").disabled).toBe(true);
    f.sdk.downloadMcpAppFile.mockResolvedValueOnce({ isError: true });
    await f.button("Download JSON").click();
    expect(f.status.textContent).toBe("Download cancelled or declined.");
  });

  it("escapes caller-controlled markup and a configured resource URI", () => {
    const html = renderExpensesUi({
      requestedBy: '<img src=x onerror="bad()">',
      identityType: "user",
      resourceUri: 'demo://current" onmouseover="bad()',
      expenses: [],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain('data-resource-uri="demo://current&quot; onmouseover=&quot;bad()"');
  });
});
