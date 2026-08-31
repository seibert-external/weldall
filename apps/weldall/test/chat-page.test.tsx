import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatLayout from "../src/app/chat/layout";
import ChatThreadPage from "../src/app/chat/[threadId]/page";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getChatModelStatus: vi.fn(),
  getChatThreadMetadata: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("../src/app/assistant", () => ({ Assistant: () => <div>Configured chat</div> }));
vi.mock("../src/server/ai/configuration", () => ({
  getChatModelStatus: mocks.getChatModelStatus,
}));
vi.mock("../src/server/auth/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("../src/server/ai/chat-threads", () => ({
  getChatThreadMetadata: mocks.getChatThreadMetadata,
}));
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: vi.fn(),
}));

describe("chat layout", () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", emailVerified: true },
    });
    mocks.getChatModelStatus.mockResolvedValue({ enabled: false, configured: false });
    mocks.getChatThreadMetadata.mockReset().mockResolvedValue({ id: "thread-1" });
    mocks.notFound.mockReset();
  });

  it("shows a friendly message when chat is disabled", async () => {
    const html = renderToStaticMarkup(await ChatLayout({ children: null }));

    expect(html).toContain("Chat isn&#x27;t available right now");
    expect(html).toContain("disabled by an administrator");
    expect(html).not.toContain("Configured chat");
  });

  it("shows setup guidance when an enabled chat has no credential", async () => {
    mocks.getChatModelStatus.mockResolvedValue({ enabled: true, configured: false });

    expect(renderToStaticMarkup(await ChatLayout({ children: null }))).toContain(
      "finish configuring",
    );
  });

  it("shows chat when it is enabled and configured", async () => {
    mocks.getChatModelStatus.mockResolvedValue({ enabled: true, configured: true });

    expect(renderToStaticMarkup(await ChatLayout({ children: null }))).toContain("Configured chat");
  });

  it("validates a deep-linked thread with metadata only", async () => {
    await ChatThreadPage({ params: Promise.resolve({ threadId: "thread-1" }) });

    expect(mocks.getChatThreadMetadata).toHaveBeenCalledWith("user-1", "thread-1");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("returns not found for a missing or foreign deep-linked thread", async () => {
    mocks.getChatThreadMetadata.mockResolvedValue(null);

    await ChatThreadPage({ params: Promise.resolve({ threadId: "foreign-thread" }) });

    expect(mocks.notFound).toHaveBeenCalledOnce();
  });
});
