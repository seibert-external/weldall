import { requireIacMachine } from "@/server/iac/auth";
import { workspaceIdSchema } from "@/server/iac/contracts";
import { getIacState, IacError } from "@/server/iac/service";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireIacMachine(request);
    return Response.json(await getIacState(workspaceIdSchema.parse((await context.params).id)), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      {
        error: {
          code: error instanceof IacError ? error.code : "INVALID_REQUEST",
          message: error instanceof Error ? error.message : "Invalid request",
        },
      },
      { status: error instanceof IacError ? error.status : 400 },
    );
  }
}
