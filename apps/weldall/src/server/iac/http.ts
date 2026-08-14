import { requireIacMachine } from "./auth";
import { IAC_LIMITS } from "./contracts";
import { IacError } from "./service";
import { auditRequestIdentifiers } from "../audit/service";

export async function iacRoute(
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
    return Response.json(
      {
        error: {
          code: known ? error.code : "INVALID_REQUEST",
          message: known ? error.message : "The IaC request could not be processed",
          ...(known ? error.details : {}),
          requestId,
        },
      },
      {
        status: known ? error.status : 400,
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      },
    );
  }
}
