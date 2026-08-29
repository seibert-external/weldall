import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatPage from "../src/app/chat/page";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getChatModelStatus: vi.fn(),
}));

vi.mock("../src/app/assistant", () => ({ Assistant: () => <div>Configured chat</div> }));
vi.mock("../src/server/ai/configuration", () => ({
  getChatModelStatus: mocks.getChatModelStatus,
}));
vi.mock("../src/server/auth/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

describe("chat page", () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", emailVerified: true },
    });
    mocks.getChatModelStatus.mockResolvedValue({ enabled: false, configured: false });
  });

  it("shows a friendly message when chat is disabled", async () => {
    const html = renderToStaticMarkup(await ChatPage());

    expect(html).toContain("Chat isn&#x27;t available right now");
    expect(html).toContain("disabled by an administrator");
    expect(html).not.toContain("Configured chat");
  });

  it("shows setup guidance when an enabled chat has no credential", async () => {
    mocks.getChatModelStatus.mockResolvedValue({ enabled: true, configured: false });

    expect(renderToStaticMarkup(await ChatPage())).toContain("finish configuring");
  });

  it("shows chat when it is enabled and configured", async () => {
    mocks.getChatModelStatus.mockResolvedValue({ enabled: true, configured: true });

    expect(renderToStaticMarkup(await ChatPage())).toContain("Configured chat");
  });
});
