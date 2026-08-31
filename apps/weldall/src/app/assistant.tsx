"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
  useRemoteThreadListRuntime,
  type ExternalStoreBranchChange,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/ai-sdk";
import { createChatThreadListAdapter, persistChatThreadHead } from "@/app/chat/chat-thread-adapter";
import { ChatThreadList } from "@/components/assistant-ui/elements/thread-list.aui";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import {
  GetSkillToolUI,
  SearchSkillsToolUI,
  WeldallRequestToolUI,
} from "@/components/assistant-ui/elements/tool-uis";

const TOOL_UIS: ReadonlyArray<readonly [string, ToolCallMessagePartComponent]> = [
  ["searchSkills", SearchSkillsToolUI],
  ["getSkill", GetSkillToolUI],
  ["weldallRequest", WeldallRequestToolUI],
];

/**
 * Registers per-tool renderers on the runtime's tools scope. Each UI is
 * `standalone`, so the tool call renders as its own card instead of being
 * nested inside the chain-of-thought tool group.
 */
function RegisterToolUIs() {
  const aui = useAui();

  useEffect(() => {
    const unsubscribes = TOOL_UIS.map(([toolName, render]) =>
      aui.tools.setToolUI(toolName, render, { standalone: true }),
    );
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [aui]);

  return null;
}

function useWeldallThreadRuntime() {
  const threadId = useAuiState((state) => state.threadListItem.remoteId);
  const onBranchChange = useCallback(
    ({ headId }: ExternalStoreBranchChange) => {
      if (!threadId) return;
      void persistChatThreadHead(threadId, headId).catch((error: unknown) => {
        console.error("Failed to persist the selected chat branch:", error);
      });
    },
    [threadId],
  );
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
        headers: { "x-weldall-csrf": "1" },
      }),
    [],
  );
  return useChatRuntime({
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    transport,
    unstable_onBranchChange: onBranchChange,
  });
}

export function Assistant() {
  const params = useParams<{ threadId?: string | string[] }>();
  const router = useRouter();
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  const adapter = useMemo(() => createChatThreadListAdapter(), []);
  const onThreadIdChange = useCallback(
    (nextThreadId: string | undefined) => {
      const path = nextThreadId ? `/chat/${encodeURIComponent(nextThreadId)}` : "/chat";
      if (!threadId && nextThreadId) router.replace(path);
      else router.push(path);
    },
    [router, threadId],
  );
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: useWeldallThreadRuntime,
    adapter,
    threadId,
    onThreadIdChange,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RegisterToolUIs />
      <main className="chat-page flex h-dvh min-w-0 flex-col overflow-hidden md:flex-row">
        <ChatThreadList />
        <section className="min-h-0 min-w-0 flex-1">
          <Thread />
        </section>
      </main>
    </AssistantRuntimeProvider>
  );
}
