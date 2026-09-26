import { WeldallAuthError } from "@weldall/sdk";
import { z } from "zod";
import { auth } from "../auth/auth";
import { isTrustedBrowserRequest } from "../auth/browser-request";
import { authenticateCliApiRequest } from "../oauth/cli-api";
import { WELDALL_ISSUER } from "../oauth/constants";
import { auditRequestIdentifiers } from "../audit/service";
import { effectiveScopesRequiringSystemScopeFor } from "../policy/resources";
import { ConnectorError, type AuthorizedConnectorActor } from "./contracts";
import { readBoundedBody } from "./core/transport";

export const privateHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
/** Authenticates a DPoP-bound CLI caller for owner-scoped connector HTTP routes. */
export async function authenticateConnectorActor({
  request,
}: {
  request: Request;
}): Promise<AuthorizedConnectorActor> {
  return authorizeConnectorActor({
    request,
    user: await authenticateCliApiRequest(request, {
      expectedUrl: `${WELDALL_ISSUER}${new URL(request.url).pathname}`,
      requiredScope: "weldall:scopes",
    }),
  });
}
/** Uses the signed Weldall session for both setup and the returning OAuth callback. */
export async function authenticateConnectorBrowserActor({
  request,
}: {
  request: Request;
}): Promise<AuthorizedConnectorActor> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.emailVerified)
    throw new ConnectorError("unauthorized", "Sign in to Weldall to continue setup.", 401);
  if (!isTrustedBrowserRequest(request))
    throw new ConnectorError("csrf", "Untrusted browser request.", 403);
  return authorizeConnectorActor({ request, user: session.user });
}
/** Requires live login permission for either authenticated transport. */
async function authorizeConnectorActor({
  request,
  user,
}: {
  request: Request;
  user: { id: string; email: string };
}): Promise<AuthorizedConnectorActor> {
  const scopeKeys = await effectiveScopesRequiringSystemScopeFor({
    email: user.email,
    requiredSystemScope: "weldall:login",
  });
  if (!scopeKeys)
    throw new ConnectorError(
      "unauthorized",
      "Sign in to Weldall with an active login permission.",
      401,
    );
  return { id: user.id, email: user.email, scopeKeys, ...auditRequestIdentifiers(request) };
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
/** Creates the locked-down browser completion page shown after a provider OAuth callback. */
export function createConnectorCompletionResponse(outcome: "success" | "cancelled" | "failed") {
  const message = {
    success: "Connection ready. Return to the CLI to see the granted scopes.",
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
