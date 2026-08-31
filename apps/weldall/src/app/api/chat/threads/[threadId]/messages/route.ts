import {
  ChatMessageLimitError,
  ChatMessageValidationError,
  ChatThreadNotFoundError,
  deleteChatMessages,
  upsertChatMessage,
} from "@/server/ai/chat-threads";
import { authenticateChatRequest } from "@/server/ai/chat-http";
import { validateChatMessages } from "@/server/ai/messages";
import { createChatTools } from "@/server/ai/tools";
import { readJsonBody } from "@/server/http/json-body";
import { requestIdentifiers, withRequestLogging } from "@/server/observability/http";

type RouteContext = { params: Promise<{ threadId: string }> };

async function post(request: Request, context: RouteContext) {
  const authentication = await authenticateChatRequest(request);
  if (!authentication.ok) return authentication.response;
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: body.status });
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const value = body.value as Record<string, unknown>;
  const parentId = value.parentId;
  if (parentId !== null && typeof parentId !== "string") {
    return Response.json({ error: "Invalid message parent." }, { status: 400 });
  }
  const tools = createChatTools({
    principal: authentication.user,
    requestIdentifiers: requestIdentifiers(request),
  });
  const messages = await validateChatMessages([value.message], tools);
  if (!messages?.[0]) {
    return Response.json({ error: "Invalid message." }, { status: 400 });
  }

  const { threadId } = await context.params;
  try {
    await upsertChatMessage(authentication.user.id, threadId, messages[0], parentId);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof ChatThreadNotFoundError) return notFound();
    if (error instanceof ChatMessageLimitError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ChatMessageValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

async function remove(request: Request, context: RouteContext) {
  const authentication = await authenticateChatRequest(request);
  if (!authentication.ok) return authentication.response;
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: body.status });
  const ids =
    body.value && typeof body.value === "object" && !Array.isArray(body.value)
      ? (body.value as Record<string, unknown>).ids
      : undefined;
  if (
    !Array.isArray(ids) ||
    ids.length > 100 ||
    !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)
  ) {
    return Response.json({ error: "Invalid message ids." }, { status: 400 });
  }
  const { threadId } = await context.params;
  try {
    await deleteChatMessages(authentication.user.id, threadId, ids);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof ChatThreadNotFoundError) return notFound();
    if (error instanceof ChatMessageValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

function notFound() {
  return Response.json({ error: "Chat thread not found." }, { status: 404 });
}

export const POST = withRequestLogging("/api/chat/threads/[threadId]/messages", post);
export const DELETE = withRequestLogging("/api/chat/threads/[threadId]/messages", remove);
