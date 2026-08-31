import { serializeChatThreadMetadata } from "@/server/ai/chat-thread-contracts";
import {
  ChatMessageValidationError,
  ChatThreadValidationError,
  deleteChatThread,
  getChatThread,
  renameChatThread,
  setChatThreadArchived,
  setChatThreadHead,
} from "@/server/ai/chat-threads";
import { authenticateChatRequest, privateJsonHeaders } from "@/server/ai/chat-http";
import { readJsonBody } from "@/server/http/json-body";
import { withRequestLogging } from "@/server/observability/http";

type RouteContext = { params: Promise<{ threadId: string }> };

async function get(request: Request, context: RouteContext) {
  const authentication = await authenticateChatRequest(request);
  if (!authentication.ok) return authentication.response;
  const { threadId } = await context.params;
  const thread = await getChatThread(authentication.user.id, threadId);
  if (!thread) return notFound();

  return Response.json(
    {
      ...serializeChatThreadMetadata(thread),
      headMessageId: thread.headMessageId,
      messages: thread.messages.map((message) => ({
        id: message.id,
        parentId: message.parentId,
        role: message.role,
        parts: message.parts,
        createdAt: message.createdAt.toISOString(),
      })),
    },
    { headers: privateJsonHeaders },
  );
}

async function patch(request: Request, context: RouteContext) {
  const authentication = await authenticateChatRequest(request);
  if (!authentication.ok) return authentication.response;
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: body.status });
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { threadId } = await context.params;
  const value = body.value as Record<string, unknown>;
  try {
    let updated = false;
    if (
      typeof value.title === "string" &&
      value.archived === undefined &&
      value.headMessageId === undefined
    ) {
      updated = await renameChatThread(authentication.user.id, threadId, value.title);
    } else if (
      typeof value.archived === "boolean" &&
      value.title === undefined &&
      value.headMessageId === undefined
    ) {
      updated = await setChatThreadArchived(authentication.user.id, threadId, value.archived);
    } else if (
      (typeof value.headMessageId === "string" || value.headMessageId === null) &&
      value.title === undefined &&
      value.archived === undefined
    ) {
      updated = await setChatThreadHead(authentication.user.id, threadId, value.headMessageId);
    } else {
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    }
    return updated ? new Response(null, { status: 204 }) : notFound();
  } catch (error) {
    if (error instanceof ChatThreadValidationError || error instanceof ChatMessageValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

async function remove(request: Request, context: RouteContext) {
  const authentication = await authenticateChatRequest(request);
  if (!authentication.ok) return authentication.response;
  const { threadId } = await context.params;
  return (await deleteChatThread(authentication.user.id, threadId))
    ? new Response(null, { status: 204 })
    : notFound();
}

function notFound() {
  return Response.json({ error: "Chat thread not found." }, { status: 404 });
}

export const GET = withRequestLogging("/api/chat/threads/[threadId]", get);
export const PATCH = withRequestLogging("/api/chat/threads/[threadId]", patch);
export const DELETE = withRequestLogging("/api/chat/threads/[threadId]", remove);
