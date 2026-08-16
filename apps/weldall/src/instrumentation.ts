import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logger } = await import("./server/observability/logger");
  logger.info({ event: "application.initialized" }, "Weldall server initialized");
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { errorForLog, logger } = await import("./server/observability/logger");
  logger.error(
    {
      event: "next.request.failed",
      error: errorForLog(error),
      method: request.method,
      route: context.routePath,
      routerKind: context.routerKind,
      routeType: context.routeType,
    },
    "Unhandled Next.js request error",
  );
};
