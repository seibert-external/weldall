import { after } from "next/server";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";
import { withRequestLogging } from "@/server/observability/http";
import { errorForLog, logger } from "@/server/observability/logger";
import { refreshDueCatalogs } from "@/server/skills/catalogs";
import { recordSkillRetrievalEvent } from "@/server/skills/retrieval-metrics";
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
    if (!skill) {
      return Response.json(
        { error: "not_found", error_description: "Skill not found" },
        { status: 404 },
      );
    }
    await recordSkillRetrievalEvent({
      skillSlug: slug,
      retrieverId: user.id,
      retrieverName: user.name.trim() || user.email,
    }).catch((error) => {
      logger.warn(
        {
          event: "skill_retrieval.record.failed",
          error: errorForLog(error),
          skillSlug: slug,
          retrieverId: user.id,
        },
        "Failed to record skill retrieval",
      );
    });
    return Response.json(skill);
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
