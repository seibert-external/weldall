import { completion } from "@/server/connectors/http";
export async function GET(_request: Request, context: { params: Promise<{ outcome: string }> }) {
  const { outcome } = await context.params;
  return completion(outcome === "success" || outcome === "cancelled" ? outcome : "failed");
}
