import { withRequestLogging } from "@/server/observability/http";
import { appRegistryApi } from "@/server/app-registry/machine-api";

export const GET = withRequestLogging("/api/app-registry/v1/apps", appRegistryApi);
