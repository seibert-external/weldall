import { describe, expect, it, vi } from "vitest";
import {
  createChatThreadHistoryAdapter,
  createChatThreadListAdapter,
  persistChatThreadHead,
} from "../src/app/chat/chat-thread-adapter";

const metadata = {
  remoteId: "thread-1",
  status: "regular" as const,
  title: "First thread",
  lastMessageAt: "2026-03-01T12:00:00.000Z",
};

function jsonResponse(value: unknown, status = 200) {
  return Response.json(value, { status });
}

describe("chat thread remote adapter", () => {
  it("maps list and fetch wire metadata to assistant-ui shapes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ threads: [metadata], nextCursor: "next" }))
      .mockResolvedValueOnce(jsonResponse({ ...metadata, messages: [] }));
    const adapter = createChatThreadListAdapter(fetcher);

    await expect(adapter.list({ after: "cursor" })).resolves.toEqual({
      threads: [{ ...metadata, lastMessageAt: new Date(metadata.lastMessageAt) }],
      nextCursor: "next",
    });
    await expect(adapter.fetch("thread-1")).resolves.toEqual({
      ...metadata,
      lastMessageAt: new Date(metadata.lastMessageAt),
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/chat/threads?includeArchived=true&limit=30&after=cursor",
    );
  });

  it("uses JSON and CSRF headers for initialize and mutations", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(metadata, 201))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const adapter = createChatThreadListAdapter(fetcher);

    await expect(adapter.initialize("local-id")).resolves.toEqual({ remoteId: "thread-1" });
    await adapter.rename("thread-1", "Renamed");
    await adapter.archive("thread-1");
    await adapter.unarchive("thread-1");
    await adapter.delete("thread-1");

    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).get("x-weldall-csrf")).toBe("1");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    }
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ title: "Renamed" });
  });

  it("loads and writes full UI message parts through withFormat", async () => {
    const storedMessage = {
      id: "message-1",
      parentId: null,
      role: "assistant",
      parts: [
        {
          type: "tool-searchSkills",
          toolCallId: "call-1",
          state: "output-available",
          input: { query: "expenses" },
          output: { skills: [] },
        },
      ],
      createdAt: "2026-03-01T12:00:00.000Z",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          ...metadata,
          headMessageId: "message-1",
          messages: [storedMessage],
        }),
      )
      .mockResolvedValue(new Response(null, { status: 204 }));
    const history = createChatThreadHistoryAdapter("thread-1", fetcher);
    const formatted = history.withFormat!({
      format: "test",
      encode: ({ message: { id: _id, ...content } }) => content,
      decode: (entry) => ({
        parentId: entry.parent_id,
        message: { id: entry.id, ...entry.content },
      }),
      getId: (message: { id: string }) => message.id,
    });

    const loaded = await formatted.load();
    expect(loaded).toEqual({
      headId: "message-1",
      messages: [
        {
          parentId: null,
          message: {
            id: "message-1",
            role: "assistant",
            parts: storedMessage.parts,
          },
        },
      ],
    });

    const item = loaded.messages[0]!;
    await formatted.append(item);
    await formatted.update!(item, "message-1");
    await formatted.delete!([item]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      parentId: null,
      message: item.message,
    });
    expect(fetcher.mock.calls[3]?.[1]?.method).toBe("DELETE");
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({
      ids: ["message-1"],
    });
  });

  it("persists an explicit branch head with CSRF protection", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    await persistChatThreadHead("thread-1", "message-branch", fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/chat/threads/thread-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ headMessageId: "message-branch" }),
      }),
    );
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-weldall-csrf")).toBe("1");
  });
});
