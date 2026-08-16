import { WeldallAuthError, oauthErrorResponse } from "@weldall/sdk";
import { errorForLog, logger } from "../observability/logger";

export function loggedOauthErrorResponse(error: unknown): Response {
  if (!(error instanceof WeldallAuthError) || error.status >= 500) {
    logger.error(
      {
        event: "oauth.request.failed",
        error: errorForLog(error),
        ...(error instanceof WeldallAuthError
          ? { oauthError: error.code, status: error.status }
          : { status: 500 }),
      },
      "OAuth request failed",
    );
  }
  return oauthErrorResponse(error);
}
