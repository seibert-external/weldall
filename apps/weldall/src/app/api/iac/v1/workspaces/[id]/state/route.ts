import { ZodError } from "zod";
import { requireIacMachine } from "@/server/iac/auth";
import { workspaceIdSchema } from "@/server/iac/contracts";
import { getIacState, IacError } from "@/server/iac/service";
import { withRequestLogging } from "@/server/observability/http";
import { errorForLog, logger } from "@/server/observability/logger";

async function get(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireIacMachine(request);
    return Response.json(await getIacState(workspaceIdSchema.parse((await context.params).id)), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    const known = error instanceof IacError;
    const invalid = error instanceof ZodError;
    if (!known && !invalid) {
      logger.error(
        { event: "iac.state.failed", error: errorForLog(error) },
        "IaC state request failed unexpectedly",
      );
    }
    return Response.json(
      {
        error: {
          code: known ? error.code : invalid ? "INVALID_REQUEST" : "INTERNAL_ERROR",
          message: known
            ? error.message
            : invalid
              ? "Invalid request"
              : "An internal error prevented the IaC state request from completing",
        },
      },
      { status: known ? error.status : invalid ? 400 : 500 },
    );
  }
}

export const GET = withRequestLogging("/api/iac/v1/workspaces/[id]/state", get);
