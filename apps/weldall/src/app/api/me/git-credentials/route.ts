import { z } from "zod";
import {
  authenticateConnectorActor,
  createConnectorErrorResponse,
  createJsonResponse,
  parseJsonRequestBody,
} from "@/server/connectors/http";
import { issueGitCredential } from "@/server/git-proxy/credentials";

/**
 * Issues a short-lived credential for Weldall's git proxy to the CLI caller (DPoP login), for one
 * of their apps: `{ path: "git/<connector>/<owner>/<repository>.git", access: "read" | "write" }`
 * returns `{ username, password, expiresAt }` for git's Basic auth. Valid only at the git proxy.
 */
export async function POST(request: Request) {
  try {
    const actor = await authenticateConnectorActor({ request });
    const input = await parseJsonRequestBody({
      request,
      schema: z
        .object({ path: z.string().min(1).max(400), access: z.enum(["read", "write"]) })
        .strict(),
    });
    return createJsonResponse(await issueGitCredential({ actor, input }));
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}
