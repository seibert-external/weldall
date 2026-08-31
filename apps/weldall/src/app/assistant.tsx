"use client";

import { useChat } from "@ai-sdk/react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { AssistantChatTransport, useAISDKRuntime } from "@assistant-ui/ai-sdk";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";

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
      <main className="chat-page h-dvh overflow-hidden">
        <Thread />
      </main>
    </AssistantRuntimeProvider>
  );
}
