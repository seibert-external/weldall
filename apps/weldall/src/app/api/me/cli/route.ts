import { db } from "@weldall/db";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";
import { withRequestLogging } from "@/server/observability/http";

const endpoint = `${WELDALL_ISSUER}/api/me/cli`;

async function get(request: Request) {
  try {
    await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      requiredScope: "weldall:scopes",
    });
    const settings = await db.cliSettings.findUnique({
      where: { id: "default" },
      select: { appendix: true, updatedAt: true },
    });
    return Response.json(
      {
        appendix: settings?.appendix ?? "",
        updatedAt: settings?.updatedAt.toISOString() ?? null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

export const GET = withRequestLogging("/api/me/cli", get);
