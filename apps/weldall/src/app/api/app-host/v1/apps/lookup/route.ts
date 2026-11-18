import { withRequestLogging } from "@/server/observability/http";
import { appHostLookupApp } from "@/server/app-host/apps";

export const POST = withRequestLogging("/api/app-host/v1/apps/lookup", appHostLookupApp);
