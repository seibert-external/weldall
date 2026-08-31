"use client";

import { useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import { AssistantRuntimeProvider, useAui, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { AssistantChatTransport, useAISDKRuntime } from "@assistant-ui/ai-sdk";
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

export function Assistant() {
  const chat = useChat({
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    transport: new AssistantChatTransport({
      api: "/api/chat",
      headers: { "x-weldall-csrf": "1" },
    }),
  });
  const runtime = useAISDKRuntime(chat);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RegisterToolUIs />
      <main className="chat-page h-dvh overflow-hidden">
        <Thread />
      </main>
    </AssistantRuntimeProvider>
  );
}
