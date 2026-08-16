import { requireIacMachine } from "./auth";
import { IAC_LIMITS } from "./contracts";
import { IacError } from "./service";
import { auditRequestIdentifiers } from "../audit/service";
import { withRequestLogging } from "../observability/http";
import { errorForLog, logger } from "../observability/logger";
import { ZodError } from "zod";

export async function iacRoute(
  request: Request,
  handler: (body: any, actor: Awaited<ReturnType<typeof requireIacMachine>>) => Promise<unknown>,
): Promise<Response> {
  return await withRequestLogging(new URL(request.url).pathname, (contextualRequest) =>
    executeIacRoute(contextualRequest, handler),
  )(request);
}

async function executeIacRoute(
  request: Request,
  handler: (body: any, actor: Awaited<ReturnType<typeof requireIacMachine>>) => Promise<unknown>,
): Promise<Response> {
  const identifiers = auditRequestIdentifiers(request);
  const requestId = identifiers.requestId;
  try {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > IAC_LIMITS.payloadBytes)
      throw new IacError("PAYLOAD_TOO_LARGE", "IaC payload exceeds one megabyte", 413);
    const actor = await requireIacMachine(request, undefined, identifiers);
    const text = await request.text();
    if (Buffer.byteLength(text) > IAC_LIMITS.payloadBytes)
      throw new IacError("PAYLOAD_TOO_LARGE", "IaC payload exceeds one megabyte", 413);
    const body = text ? JSON.parse(text) : {};
    const result = await handler(body, actor);
    return Response.json(result, {
      headers: { "cache-control": "no-store", "x-request-id": requestId },
    });
  } catch (error) {
    if (error instanceof Response) {
      const headers = new Headers(error.headers);
      headers.set("cache-control", "no-store");
      headers.set("x-request-id", requestId);
      return new Response(error.body, {
        status: error.status,
        statusText: error.statusText,
        headers,
      });
    }
    const known = error instanceof IacError;
    const invalid = error instanceof ZodError || error instanceof SyntaxError;
    if (!known && !invalid) {
      logger.error(
        { event: "iac.request.failed", error: errorForLog(error) },
        "IaC request failed unexpectedly",
      );
    }
    return Response.json(
      {
        error: {
          code: known ? error.code : invalid ? "INVALID_REQUEST" : "INTERNAL_ERROR",
          message: known
            ? error.message
            : invalid
              ? "The IaC request could not be processed"
              : "An internal error prevented the IaC request from completing",
          ...(known ? error.details : {}),
          requestId,
        },
      },
      {
        status: known ? error.status : invalid ? 400 : 500,
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      },
    );
  }
}
