import { WeldallAuthError } from "@weldall/sdk";
import { z } from "zod";
import { authenticateCliApiRequest } from "../oauth/cli-api";
import { loggedOauthErrorResponse } from "../oauth/error-response";
import { WELDALL_ISSUER } from "../oauth/constants";
import { auditRequestIdentifiers } from "../audit/service";
import { ConnectorUserError, type ConnectorUserActor } from "./personal-connection-service";

const MAX_BODY_BYTES = 32_000;

export async function connectorActor(request: Request): Promise<ConnectorUserActor> {
  const url = new URL(request.url);
  const user = await authenticateCliApiRequest(request, {
    expectedUrl: `${WELDALL_ISSUER}${url.pathname}`,
    requiredScope: "weldall:scopes",
  });
  return { ...user, ...auditRequestIdentifiers(request) };
}

export async function connectorJsonBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new ConnectorUserError("invalid_request", "JSON content type required.");
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ConnectorUserError("invalid_request", "Request body is too large.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new ConnectorUserError("invalid_request", "Request body is too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ConnectorUserError("invalid_request", "Invalid JSON body.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ConnectorUserError("invalid_request", "Invalid request body.");
  return parsed.data;
}

export function connectorErrorResponse(error: unknown): Response {
  if (error instanceof WeldallAuthError) return loggedOauthErrorResponse(error);
  if (error instanceof ConnectorUserError) {
    return Response.json(
      {
        error: error.code,
        error_description: error.message,
      },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  }
  return loggedOauthErrorResponse(error);
}
