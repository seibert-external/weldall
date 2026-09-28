import { createConnectorCompletionResponse } from "@/server/connectors/http";

/** Renders the locked-down browser result page after Weldall completes the provider callback. */
export async function GET(_request: Request, context: { params: Promise<{ outcome: string }> }) {
  const { outcome } = await context.params;
  return createConnectorCompletionResponse(
    outcome === "success" || outcome === "cancelled" ? outcome : "failed",
  );
}
