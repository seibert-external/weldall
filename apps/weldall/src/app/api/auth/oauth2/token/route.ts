import { withRequestLogging } from "@/server/observability/http";
import { tokenFacade } from "@/server/oauth/facade";

export const POST = withRequestLogging("/api/auth/oauth2/token", tokenFacade);
