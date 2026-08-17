import { withRequestLogging } from "@/server/observability/http";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";
import { listBrowserConnections, revokeBrowserConnections } from "@/server/oauth/browser-sessions";
import { WeldallAuthError } from "@weldall/sdk";
import { auditRequestIdentifiers } from "@/server/audit/service";

const endpoint = `${WELDALL_ISSUER}/api/me/browser-connections`;

async function get(request: Request) {
  try {
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      expectedClientId: "weldall-cli",
      requiredScope: "weldall:scopes",
    });
    return Response.json(
      { items: await listBrowserConnections({ userId: user.id }) },
      {
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

async function post(request: Request) {
  try {
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      expectedClientId: "weldall-cli",
      requiredScope: "weldall:scopes",
    });
    if (
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
    )
      throw new WeldallAuthError("invalid_request");
    const raw = await request.clone().text();
    if (new TextEncoder().encode(raw).byteLength > 2_048)
      throw new WeldallAuthError("invalid_request");
    let body: unknown;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      throw new WeldallAuthError("invalid_request");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new WeldallAuthError("invalid_request");
    const record = body as Record<string, unknown>;
    const one =
      Object.keys(record).join("") === "connectionId" && typeof record.connectionId === "string";
    const all = Object.keys(record).join("") === "all" && record.all === true;
    if (!one && !all) throw new WeldallAuthError("invalid_request");
    return Response.json(
      await revokeBrowserConnections(
        { ...(one ? { connectionId: record.connectionId as string } : {}), userId: user.id },
        { id: user.id, email: user.email, ...auditRequestIdentifiers(request) },
      ),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

export const GET = withRequestLogging("/api/me/browser-connections", get);
export const POST = withRequestLogging("/api/me/browser-connections", post);
