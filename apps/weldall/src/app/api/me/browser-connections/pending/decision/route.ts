import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import {
  auditBrowserConnectionFailure,
  decidePendingBrowserConnection,
  parsePendingRequestBody,
} from "@/server/oauth/browser-connections";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";
import { withRequestLogging } from "@/server/observability/http";

const endpoint = `${WELDALL_ISSUER}/api/me/browser-connections/pending/decision`;

async function post(request: Request) {
  try {
    const { userCode, approve } = await parsePendingRequestBody(request, true);
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      expectedClientId: "weldall-cli",
      requiredScope: "weldall:scopes",
    });
    return Response.json(await decidePendingBrowserConnection(request, user, userCode, approve!), {
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    });
  } catch (error) {
    await auditBrowserConnectionFailure(request, "decision", error);
    return loggedOauthErrorResponse(error);
  }
}

export const POST = withRequestLogging("/api/me/browser-connections/pending/decision", post);
