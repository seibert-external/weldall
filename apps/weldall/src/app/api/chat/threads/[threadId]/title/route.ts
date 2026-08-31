import { ChatThreadNotFoundError, generateChatThreadTitle } from "@/server/ai/chat-threads";
import { authenticateChatRequest, privateJsonHeaders } from "@/server/ai/chat-http";
import { readJsonBody } from "@/server/http/json-body";
import { withRequestLogging } from "@/server/observability/http";

type RouteContext = { params: Promise<{ threadId: string }> };

async function post(request: Request, context: RouteContext) {
  const authentication = await authenticateChatRequest(request);
  if (!authentication.ok) return authentication.response;
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: body.status });
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const sourceText = (body.value as Record<string, unknown>).text;
  if (sourceText !== undefined && (typeof sourceText !== "string" || sourceText.length > 10_000)) {
    return Response.json({ error: "Invalid title source." }, { status: 400 });
  }

  const { threadId } = await context.params;
  try {
    const title = await generateChatThreadTitle(authentication.user.id, threadId, sourceText);
    return Response.json({ title }, { headers: privateJsonHeaders });
  } catch (error) {
    if (error instanceof ChatThreadNotFoundError) {
      return Response.json({ error: "Chat thread not found." }, { status: 404 });
    }
    throw error;
  }
}

export const POST = withRequestLogging("/api/chat/threads/[threadId]/title", post);
