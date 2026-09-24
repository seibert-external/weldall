import { WeldallAuthError } from "@weldall/sdk";
import { z } from "zod";
import { auth } from "../auth/auth";
import { isTrustedBrowserRequest } from "../auth/browser-request";
import { authenticateCliApiRequest } from "../oauth/cli-api";
import { WELDALL_ISSUER } from "../oauth/constants";
import { auditRequestIdentifiers } from "../audit/service";
import { hasEffectiveSystemScopeFor } from "../policy/resources";
import { ConnectorError, type ConnectorActor } from "./contracts";
import { readBoundedBody } from "./google";

export const privateHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
/** Authenticates a CLI or trusted-browser caller for owner-scoped connector HTTP routes. */
export async function authenticateConnectorActor({
  request,
  browser = false,
}: {
  request: Request;
  browser?: boolean;
}): Promise<ConnectorActor> {
  const user = browser
    ? (await auth.api.getSession({ headers: request.headers }))?.user
    : await authenticateCliApiRequest(request, {
        expectedUrl: `${WELDALL_ISSUER}${new URL(request.url).pathname}`,
        requiredScope: "weldall:scopes",
      });
  if (!user || !(await hasEffectiveSystemScopeFor(user.email, "weldall:login")))
    throw new ConnectorError(
      "unauthorized",
      "Sign in to Weldall with an active login permission.",
      401,
    );
  if (browser && !isTrustedBrowserRequest(request))
    throw new ConnectorError("csrf", "Untrusted browser request.", 403);
  return { id: user.id, email: user.email, ...auditRequestIdentifiers(request) };
}
/** Parses a bounded JSON body for connector routes and applies the route's Zod contract. */
export async function parseJsonRequestBody<T extends z.ZodType>({
  request,
  schema,
}: {
  request: Request;
  schema: T;
}): Promise<z.infer<T>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    throw new ConnectorError("invalid_request", "JSON required.");
  try {
    return schema.parse(
      JSON.parse(
        Buffer.from(await readBoundedBody({ response: request, maximum: 32_000 })).toString("utf8"),
      ),
    );
  } catch {
    throw new ConnectorError("invalid_request", "Invalid request body.");
  }
}
/** Creates a non-cacheable JSON response for private connector metadata and lifecycle APIs. */
export function createJsonResponse(value: unknown) {
  return Response.json(value, { headers: privateHeaders });
}
/** Maps connector and Weldall authentication failures onto the stable private HTTP error contract. */
export function createConnectorErrorResponse(error: unknown) {
  if (error instanceof ConnectorError)
    return Response.json(
      { error: error.code, error_description: error.message },
      { status: error.status, headers: privateHeaders },
    );
  if (error instanceof WeldallAuthError)
    return Response.json(
      { error: error.code, error_description: "Weldall authentication failed." },
      { status: error.status, headers: privateHeaders },
    );
  return Response.json(
    {
      error: "connector_unavailable",
      error_description: "Connector operation could not complete. Reload status before retrying.",
    },
    { status: 503, headers: privateHeaders },
  );
}
/** Creates the locked-down browser completion page shown after the Google OAuth callback. */
export function createConnectorCompletionResponse(outcome: "success" | "cancelled" | "failed") {
  const message = {
    success: "Connection ready. Return to the CLI to see the granted capabilities.",
    cancelled: "Authorization cancelled. Return to the CLI.",
    failed: "Authorization failed. Return to the CLI to check status and any required cleanup.",
  }[outcome];
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Weldall connection</title><p>${message}</p></html>`,
    {
      status: outcome === "failed" ? 400 : 200,
      headers: {
        ...privateHeaders,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );
}
