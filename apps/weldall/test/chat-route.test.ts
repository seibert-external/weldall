import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveChatModelConfig: vi.fn(),
}));

vi.mock("../src/server/auth/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("../src/server/ai/configuration", () => ({
  resolveChatModelConfig: mocks.resolveChatModelConfig,
}));

import { POST } from "../src/app/api/chat/route";
import { WELDALL_ISSUER } from "../src/server/oauth/constants";

function request(body: string, headers: Record<string, string> = {}) {
  return new Request("https://weldall.example/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: new URL(WELDALL_ISSUER).origin,
      "Sec-Fetch-Site": "same-origin",
      "X-Weldall-CSRF": "1",
      ...headers,
    },
    body,
  });
}

const session = {
  user: {
    id: "user-1",
    email: "user@example.com",
    emailVerified: true,
    name: "User",
  },
};

describe("chat route", () => {
  beforeEach(() => {
    mocks.getSession.mockReset().mockResolvedValue(null);
    mocks.resolveChatModelConfig.mockReset().mockImplementation(() => {
      throw new Error("not configured");
    });
  });

  it("rejects anonymous requests", async () => {
    const response = await POST(request(JSON.stringify({ messages: [] })));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects untrusted browser requests", async () => {
    mocks.getSession.mockResolvedValue(session);

    const response = await POST(
      request(JSON.stringify({ messages: [] }), { Origin: "https://attacker.example" }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Invalid request origin." });
  });

  it.each([
    { messages: "invalid" },
    { messages: [null] },
    {
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [
            {
              type: "file",
              mediaType: "image/png",
              url: "http://169.254.169.254/latest/meta-data",
            },
          ],
        },
      ],
    },
  ])("rejects malformed or non-text messages", async (body) => {
    mocks.getSession.mockResolvedValue(session);

    const response = await POST(request(JSON.stringify(body)));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid messages." });
  });

  it("rejects oversized request bodies before parsing", async () => {
    mocks.getSession.mockResolvedValue(session);

    const response = await POST(
      request(JSON.stringify({ messages: [], ignored: "x".repeat(1_000_001) })),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
  });

  it("accepts a valid text conversation", async () => {
    mocks.getSession.mockResolvedValue(session);

    const response = await POST(
      request(
        JSON.stringify({
          messages: [{ id: "message-1", role: "user", parts: [{ type: "text", text: "Hello" }] }],
        }),
      ),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Chat model is not configured." });
    expect(mocks.resolveChatModelConfig).toHaveBeenCalledOnce();
  });
});
