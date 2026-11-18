import { withRequestLogging } from "@/server/observability/http";
import { appHostUpdateApp } from "@/server/app-host/apps";

type Context = { params: Promise<{ id: string }> };

export const PATCH = withRequestLogging(
  "/api/app-host/v1/apps/[id]",
  async (request: Request, context: Context) =>
    appHostUpdateApp(request, (await context.params).id),
);
