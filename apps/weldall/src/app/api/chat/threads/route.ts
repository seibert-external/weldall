import { serializeChatThreadMetadata } from "@/server/ai/chat-thread-contracts";
import { ChatThreadCursorError, createChatThread, listChatThreads } from "@/server/ai/chat-threads";
import { authenticateChatRequest, privateJsonHeaders } from "@/server/ai/chat-http";
import { readJsonBody } from "@/server/http/json-body";
import { withRequestLogging } from "@/server/observability/http";

async function get(request: Request) {
  const authentication = await authenticateChatRequest(request);
  if (!authentication.ok) return authentication.response;

  const url = new URL(request.url);
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
    return Response.json({ error: "Invalid page size." }, { status: 400 });
  }
  try {
    const after = url.searchParams.get("after");
    const page = await listChatThreads(authentication.user.id, {
      ...(after ? { after } : {}),
      includeArchived: url.searchParams.get("includeArchived") === "true",
      ...(limit !== undefined ? { limit } : {}),
    });
    return Response.json(
      {
        threads: page.threads.map(serializeChatThreadMetadata),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      },
      { headers: privateJsonHeaders },
    );
  } catch (error) {
    if (error instanceof ChatThreadCursorError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

async function post(request: Request) {
  const authentication = await authenticateChatRequest(request);
  if (!authentication.ok) return authentication.response;
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: body.status });
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const thread = await createChatThread(authentication.user.id);
  return Response.json(serializeChatThreadMetadata(thread), {
    status: 201,
    headers: privateJsonHeaders,
  });
}

export const GET = withRequestLogging("/api/chat/threads", get);
export const POST = withRequestLogging("/api/chat/threads", post);
