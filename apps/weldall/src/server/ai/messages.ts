import {
  safeValidateUIMessages,
  type InferUITools,
  type ToolSet,
  type UIDataTypes,
  type UIMessage,
} from "ai";

const MAX_MESSAGES = 100;

type ChatUIMessage<TOOLS extends ToolSet> = UIMessage<unknown, UIDataTypes, InferUITools<TOOLS>>;

export async function validateChatMessages<TOOLS extends ToolSet = {}>(
  value: unknown,
  tools?: TOOLS,
): Promise<ChatUIMessage<TOOLS>[] | undefined> {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) return undefined;

  const validation = await safeValidateUIMessages<ChatUIMessage<TOOLS>>({
    messages: value,
    ...(tools ? { tools } : {}),
  });
  const toolTypes = new Set(Object.keys(tools ?? {}).map((name) => `tool-${name}`));
  if (
    !validation.success ||
    !validation.data.every((message) => isAcceptedMessage(message, toolTypes))
  ) {
    return undefined;
  }

  return validation.data.map(sanitizeMessage) as ChatUIMessage<TOOLS>[];
}

function isAcceptedMessage(message: UIMessage, toolTypes: ReadonlySet<string>): boolean {
  if (message.role === "user") return message.parts.every((part) => part.type === "text");
  if (message.role !== "assistant") return false;
  return message.parts.every(
    (part) =>
      part.type === "text" ||
      part.type === "reasoning" ||
      part.type === "step-start" ||
      toolTypes.has(part.type),
  );
}

function sanitizeMessage(message: UIMessage): UIMessage {
  const parts: UIMessage["parts"] = message.parts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "reasoning") return { type: "reasoning", text: part.text };
    if (part.type === "step-start") return { type: "step-start" };

    const sanitized = { ...part } as Record<string, unknown>;
    delete sanitized.callProviderMetadata;
    delete sanitized.resultProviderMetadata;
    delete sanitized.providerMetadata;
    delete sanitized.providerExecuted;
    delete sanitized.toolMetadata;
    return sanitized as UIMessage["parts"][number];
  });

  return { id: message.id, role: message.role, parts };
}
