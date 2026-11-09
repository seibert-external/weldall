import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";
import { withRequestLogging } from "@/server/observability/http";
import { policyEtag, withoutInstructions } from "@/server/policy/client-policy";
import { effectivePolicyFor } from "@/server/policy/resources";

const endpoint = `${WELDALL_ISSUER}/api/me/policy`;
const headers = { "cache-control": "no-store" };

async function get(request: Request) {
  try {
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      requiredScope: "weldall:scopes",
    });
    const effective = await effectivePolicyFor(user.email);
    // A missing group could make the merged policy stricter or looser than intended; the client
    // keeps its last policy instead.
    if (effective.unavailableGroupProviders.length)
      return Response.json({ error: "group_provider_unavailable" }, { status: 503, headers });
    const policy = withoutInstructions(effective.policy);
    return Response.json(
      {
        version: 1,
        policy,
        updatedAt: effective.updatedAt?.toISOString() ?? null,
        etag: policyEtag(policy),
      },
      { headers },
    );
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

export const GET = withRequestLogging("/api/me/policy", get);
