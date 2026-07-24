import { db } from "@weldall/db";
import { WELDALL_ISSUER, oauthErrorResponse } from "@weldall/oauth";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";

const endpoint = `${WELDALL_ISSUER}/api/me/cli`;

export async function GET(request: Request) {
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
    return oauthErrorResponse(error);
  }
}
