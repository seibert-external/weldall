import { randomUUID } from "node:crypto";
import { errorForLog, logger, type LogContext } from "./logger";

const identifierPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export interface RequestIdentifiers {
  requestId: string;
  correlationId?: string;
}

export function requestIdentifiers(request: Request): RequestIdentifiers {
  const suppliedRequestId = request.headers.get("x-request-id")?.trim();
  const suppliedCorrelationId = request.headers.get("x-correlation-id")?.trim();
  return {
    requestId:
      suppliedRequestId && identifierPattern.test(suppliedRequestId)
        ? suppliedRequestId
        : randomUUID(),
    ...(suppliedCorrelationId && identifierPattern.test(suppliedCorrelationId)
      ? { correlationId: suppliedCorrelationId }
      : {}),
  };
}

type RouteHandler<Args extends unknown[]> = (
  request: Request,
  ...args: Args
) => Response | Promise<Response>;

interface RequestLoggingOptions {
  successLevel?: "info" | "debug";
}

export function withRequestLogging<Args extends unknown[]>(
  route: string,
  handler: RouteHandler<Args>,
  options: RequestLoggingOptions = {},
): RouteHandler<Args> {
  return async (request, ...args) => {
    const identifiers = requestIdentifiers(request);
    const context: LogContext = {
      ...identifiers,
      method: request.method,
      route,
    };
    const headers = new Headers(request.headers);
    headers.set("x-request-id", identifiers.requestId);
    if (identifiers.correlationId) headers.set("x-correlation-id", identifiers.correlationId);
    else headers.delete("x-correlation-id");
    const contextualRequest = new Request(request, { headers });

    return logger.runInContext(context, async () => {
      const started = performance.now();
      logger.debug({ event: "http.request.started" }, "HTTP request started");
      try {
        const response = await handler(contextualRequest, ...args);
        const durationMs = Math.max(0, Math.round(performance.now() - started));
        const fields = {
          event: "http.request.completed",
          status: response.status,
          durationMs,
        };
        if (response.status >= 500) logger.error(fields, "HTTP request completed");
        else if (response.status >= 400) logger.warn(fields, "HTTP request completed");
        else if (options.successLevel === "debug") logger.debug(fields, "HTTP request completed");
        else logger.info(fields, "HTTP request completed");

        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("x-request-id", identifiers.requestId);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      } catch (error) {
        logger.error(
          {
            event: "http.request.failed",
            durationMs: Math.max(0, Math.round(performance.now() - started)),
            error: errorForLog(error),
          },
          "HTTP request failed",
        );
        throw error;
      }
    });
  };
}
