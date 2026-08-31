"use client";

import {
  RuntimeAdapterProvider,
  type GenericThreadHistoryAdapter,
  type MessageFormatAdapter,
  type MessageFormatItem,
  type MessageFormatRepository,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
  useAuiState,
} from "@assistant-ui/react";
import { createAssistantStream } from "assistant-stream";
import { useMemo, type PropsWithChildren } from "react";

export type ChatThreadWireMetadata = {
  remoteId: string;
  status: "regular" | "archived";
  title?: string;
  lastMessageAt: string;
};

type ChatThreadWireMessage = {
  id: string;
  parentId: string | null;
  role: string;
  parts: unknown[];
  createdAt: string;
};

type ChatThreadWireDetail = ChatThreadWireMetadata & {
  headMessageId: string | null;
  messages: ChatThreadWireMessage[];
};

type Fetcher = typeof fetch;

export function createChatThreadListAdapter(fetcher: Fetcher = fetch): RemoteThreadListAdapter {
  const historyProvider = ({ children }: PropsWithChildren) => {
    const threadId = useAuiState((state) => state.threadListItem.remoteId);
    const history = useMemo(
      () => (threadId ? createChatThreadHistoryAdapter(threadId, fetcher) : undefined),
      [threadId, fetcher],
    );
    const adapters = useMemo(() => ({ history }), [history]);
    return <RuntimeAdapterProvider adapters={adapters}>{children}</RuntimeAdapterProvider>;
  };

  return {
    unstable_Provider: historyProvider,
    async list(params) {
      const search = new URLSearchParams({ includeArchived: "true", limit: "30" });
      if (params?.after) search.set("after", params.after);
      const value = await requestJson<{
        threads: ChatThreadWireMetadata[];
        nextCursor?: string;
      }>(fetcher, `/api/chat/threads?${search}`);
      return {
        threads: value.threads.map(toRemoteMetadata),
        ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}),
      };
    },
    async initialize() {
      const value = await requestJson<ChatThreadWireMetadata>(fetcher, "/api/chat/threads", {
        method: "POST",
        body: {},
      });
      return { remoteId: value.remoteId };
    },
    async fetch(threadId) {
      const value = await requestJson<ChatThreadWireDetail>(
        fetcher,
        `/api/chat/threads/${encodeURIComponent(threadId)}`,
      );
      return toRemoteMetadata(value);
    },
    async rename(remoteId, title) {
      await requestJson(fetcher, threadUrl(remoteId), { method: "PATCH", body: { title } });
    },
    async archive(remoteId) {
      await requestJson(fetcher, threadUrl(remoteId), {
        method: "PATCH",
        body: { archived: true },
      });
    },
    async unarchive(remoteId) {
      await requestJson(fetcher, threadUrl(remoteId), {
        method: "PATCH",
        body: { archived: false },
      });
    },
    async delete(remoteId) {
      await requestJson(fetcher, threadUrl(remoteId), { method: "DELETE", body: {} });
    },
    async generateTitle(remoteId, messages) {
      const text = messages
        .find((message) => message.role === "user")
        ?.content.find((part) => part.type === "text")?.text;
      const value = await requestJson<{ title: string }>(fetcher, `${threadUrl(remoteId)}/title`, {
        method: "POST",
        body: text ? { text } : {},
      });
      return createAssistantStream((controller) => controller.appendText(value.title));
    },
  };
}

export function createChatThreadHistoryAdapter(
  threadId: string,
  fetcher: Fetcher = fetch,
): ThreadHistoryAdapter {
  return {
    async load() {
      return { messages: [] };
    },
    async append() {},
    withFormat<TMessage, TStorageFormat extends Record<string, unknown>>(
      formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>,
    ): GenericThreadHistoryAdapter<TMessage> {
      const write = async (item: MessageFormatItem<TMessage>) => {
        await requestJson(fetcher, `${threadUrl(threadId)}/messages`, {
          method: "POST",
          body: { parentId: item.parentId, message: item.message },
        });
      };
      return {
        async load(): Promise<MessageFormatRepository<TMessage>> {
          const value = await requestJson<ChatThreadWireDetail>(fetcher, threadUrl(threadId));
          const messages = value.messages.map((message) =>
            formatAdapter.decode({
              id: message.id,
              parent_id: message.parentId,
              format: formatAdapter.format,
              content: {
                role: message.role,
                parts: message.parts,
              } as unknown as TStorageFormat,
            }),
          );
          return {
            headId: value.headMessageId,
            messages,
          };
        },
        append: write,
        async update(item) {
          await write(item);
        },
        async delete(items) {
          await requestJson(fetcher, `${threadUrl(threadId)}/messages`, {
            method: "DELETE",
            body: { ids: items.map((item) => formatAdapter.getId(item.message)) },
          });
        },
      };
    },
  };
}

export async function persistChatThreadHead(
  threadId: string,
  headMessageId: string | null,
  fetcher: Fetcher = fetch,
): Promise<void> {
  await requestJson(fetcher, threadUrl(threadId), {
    method: "PATCH",
    body: { headMessageId },
  });
}

function toRemoteMetadata(value: ChatThreadWireMetadata) {
  return {
    remoteId: value.remoteId,
    status: value.status,
    ...(value.title ? { title: value.title } : {}),
    lastMessageAt: new Date(value.lastMessageAt),
  };
}

function threadUrl(threadId: string) {
  return `/api/chat/threads/${encodeURIComponent(threadId)}`;
}

async function requestJson<T = unknown>(
  fetcher: Fetcher,
  url: string,
  options?: { method: "POST" | "PATCH" | "DELETE"; body: unknown },
): Promise<T> {
  const response = await fetcher(url, {
    method: options?.method ?? "GET",
    credentials: "same-origin",
    ...(options
      ? {
          headers: { "content-type": "application/json", "x-weldall-csrf": "1" },
          body: JSON.stringify(options.body),
        }
      : {}),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw new Error(
      value && typeof value === "object" && "error" in value && typeof value.error === "string"
        ? value.error
        : `Chat thread request failed with status ${response.status}.`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
