import { after } from "next/server";
import { auth } from "@/server/auth/auth";
import { listSearchablePrimitives } from "@/server/directory/search";
import { refreshDueCatalogs } from "@/server/skills/catalogs";

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  after(() => refreshDueCatalogs());
  return Response.json(await listSearchablePrimitives(session.user.email), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
