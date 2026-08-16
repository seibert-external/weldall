import { withRequestLogging } from "@/server/observability/http";
import { revocationFacade } from "@/server/oauth/facade";

export const POST = withRequestLogging("/api/auth/oauth2/revoke", revocationFacade);
