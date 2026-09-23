import { completeConnection } from "@/server/connectors/connections";
import { privateHeaders } from "@/server/connectors/http";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
const completion = (outcome: "success" | "cancelled" | "failed") =>
  new Response(null, {
    status: 303,
    headers: { ...privateHeaders, location: `${WELDALL_ISSUER}/api/connectors/result/${outcome}` },
  });
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  try {
    const state = query.get("state");
    if (
      !state ||
      state.length > 200 ||
      query.getAll("state").length !== 1 ||
      query.getAll("code").length > 1
    )
      return completion("failed");
    return completion(
      await completeConnection(
        state,
        query.has("error") ? null : query.get("code"),
        query.get("error") === "access_denied",
      ),
    );
  } catch {
    return completion("failed");
  }
}
