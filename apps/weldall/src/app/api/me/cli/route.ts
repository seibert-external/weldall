import { db } from "@weldall/db";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";
import { withRequestLogging } from "@/server/observability/http";
import { effectivePolicyFor } from "@/server/policy/resources";

const endpoint = `${WELDALL_ISSUER}/api/me/cli`;

async function get(request: Request) {
  try {
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      requiredScope: "weldall:scopes",
    });
    const [settings, effective] = await Promise.all([
      db.cliSettings.findUnique({
        where: { id: "default" },
        select: { appendix: true, updatedAt: true },
      }),
      effectivePolicyFor(user.email),
    ]);
    const appendix = settings?.appendix ?? "";
    // With a group provider unavailable the group instructions may be incomplete; serve only the
    // organisation appendix rather than fail the request.
    const groupInstructions = effective.unavailableGroupProviders.length
      ? undefined
      : effective.policy.instructions;
    return Response.json(
      {
        appendix: [appendix, groupInstructions].filter(Boolean).join("\n\n"),
        updatedAt: settings?.updatedAt.toISOString() ?? null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

export const GET = withRequestLogging("/api/me/cli", get);
