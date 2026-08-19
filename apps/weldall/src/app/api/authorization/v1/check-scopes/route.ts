import { withRequestLogging } from "@/server/observability/http";
import { subjectScopesCheck } from "@/server/oauth/subject-scopes-api";

export const POST = withRequestLogging("/api/authorization/v1/check-scopes", subjectScopesCheck);
