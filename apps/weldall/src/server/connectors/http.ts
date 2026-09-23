import { WeldallAuthError } from "@weldall/sdk";
import { z } from "zod";
import { auth } from "../auth/auth";
import { isTrustedBrowserRequest } from "../auth/browser-request";
import { authenticateCliApiRequest } from "../oauth/cli-api";
import { WELDALL_ISSUER } from "../oauth/constants";
import { auditRequestIdentifiers } from "../audit/service";
import { hasEffectiveSystemScopeFor } from "../policy/resources";
import { ConnectorError, type ConnectorActor } from "./contracts";
import { boundedBody } from "./google";

export const privateHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
export async function connectorActor(request: Request, browser = false): Promise<ConnectorActor> {
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
export async function jsonBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    throw new ConnectorError("invalid_request", "JSON required.");
  try {
    return schema.parse(
      JSON.parse(Buffer.from(await boundedBody(request, 32_000)).toString("utf8")),
    );
  } catch {
    throw new ConnectorError("invalid_request", "Invalid request body.");
  }
}
export function jsonResponse(value: unknown) {
  return Response.json(value, { headers: privateHeaders });
}
export function connectorErrorResponse(error: unknown) {
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
export function completion(outcome: "success" | "cancelled" | "failed") {
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
