import { auditRequestIdentifiers } from "@/server/audit/service";
import { connectorCallbackPage } from "@/server/connectors/callback-page";
import {
  completeAuthorizationCallback,
  rejectAuthorizationCallback,
} from "@/server/connectors/personal-connection-service";
import { withRequestLogging } from "@/server/observability/http";

async function get(request: Request) {
  const url = new URL(request.url);
  const stateValues = url.searchParams.getAll("state");
  const codeValues = url.searchParams.getAll("code");
  const errorValues = url.searchParams.getAll("error");
  const state = stateValues.length === 1 ? stateValues[0]! : "";
  const identifiers = auditRequestIdentifiers(request);
  if (
    stateValues.length !== 1 ||
    codeValues.length > 1 ||
    errorValues.length > 1 ||
    (codeValues.length === 1) === (errorValues.length === 1)
  ) {
    await rejectAuthorizationCallback(state, identifiers).catch(() => undefined);
    return connectorCallbackPage({ kind: "invalid" });
  }
  if (errorValues.length === 1) {
    await rejectAuthorizationCallback(state, identifiers).catch(() => undefined);
    return connectorCallbackPage({ kind: "cancelled" });
  }
  const code = codeValues[0]!;
  try {
    const result = await completeAuthorizationCallback({ state, code }, identifiers);
    return connectorCallbackPage({
      kind: "success",
      connectionName: result.connectionName,
      accountDisplayName: result.accountDisplayName,
    });
  } catch {
    return connectorCallbackPage({ kind: "failure" });
  }
}

export const GET = withRequestLogging("/api/connectors/google/callback", get);
