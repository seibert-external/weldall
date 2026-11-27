import { withRequestLogging } from "@/server/observability/http";
import { appHostReportAuditEvent } from "@/server/app-host/audit";

export const POST = withRequestLogging("/api/app-host/v1/audit-events", appHostReportAuditEvent);
