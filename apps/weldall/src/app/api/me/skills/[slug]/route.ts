import { oauthErrorResponse } from "@weldall/sdk";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { getVisibleSkill } from "@/server/skills/service";

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    const endpoint = `${WELDALL_ISSUER}/api/me/skills/${encodeURIComponent(slug)}`;
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      requiredScope: "weldall:scopes",
    });
    const skill = await getVisibleSkill(user.email, slug);
    return skill
      ? Response.json(skill)
      : Response.json(
          { error: "not_found", error_description: "Skill not found" },
          { status: 404 },
        );
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
