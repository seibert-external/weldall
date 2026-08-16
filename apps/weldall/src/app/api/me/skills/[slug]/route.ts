import { after } from "next/server";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";
import { withRequestLogging } from "@/server/observability/http";
import { refreshDueCatalogs } from "@/server/skills/catalogs";
import { getVisibleSkill, SkillTemporarilyUnavailableError } from "@/server/skills/service";

async function get(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    const endpoint = `${WELDALL_ISSUER}/api/me/skills/${encodeURIComponent(slug)}`;
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      requiredScope: "weldall:scopes",
    });
    after(() => refreshDueCatalogs());
    const skill = await getVisibleSkill(user.email, slug);
    return skill
      ? Response.json(skill)
      : Response.json(
          { error: "not_found", error_description: "Skill not found" },
          { status: 404 },
        );
  } catch (error) {
    if (error instanceof SkillTemporarilyUnavailableError) {
      return Response.json(
        { error: "temporarily_unavailable", error_description: error.message },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    return loggedOauthErrorResponse(error);
  }
}

export const GET = withRequestLogging("/api/me/skills/[slug]", get);
