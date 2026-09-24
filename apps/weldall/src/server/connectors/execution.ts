import { db } from "@weldall/db";
import { ConnectorError, type ConnectorActor } from "./contracts";
import { runConnectorTransaction } from "./configuration";
import { accessCredentials, findOwnedConnection } from "./connections";
import { calculateEffectiveCapabilities } from "./scopes";
import { readBoundedBody } from "./google";
import { resolveConnectorOperation } from "./registry";
import { writeConnectorAuditLog } from "./audit";

export const TRANSFER_LIMIT = 10 * 1024 * 1024;
const requestHeaders = ["accept", "content-type", "if-match", "if-none-match"];
const responseHeaders = [
  "content-type",
  "content-disposition",
  "etag",
  "last-modified",
  "retry-after",
];
/** Builds the allowlisted headers sent from Weldall's connector proxy to Google APIs. */
export function buildUpstreamHeaders({
  input,
  accessToken,
}: {
  input: Headers;
  accessToken: string;
}) {
  const headers = new Headers();
  for (const name of requestHeaders) {
    const value = input.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${accessToken}`);
  return headers;
}
/**
 * Authorizes and dispatches one owner-scoped request through the managed connector proxy. Provider
 * calls are never retried after dispatch because they cannot be atomic with the database state.
 */
export async function executeConnectionRequest({
  request,
  actor,
  connectorKey,
  path,
}: {
  request: Request;
  actor: ConnectorActor;
  connectorKey: string;
  path: string;
}) {
  const selector = request.headers.get("x-weldall-connection");
  if (!selector || selector.length > 160)
    throw new ConnectorError(
      "connection_required",
      "Select a connection using X-Weldall-Connection.",
    );
  const started = Date.now();
  let connectionId = "unknown";
  let operationName = "unsupported";
  try {
    const operation = resolveConnectorOperation({
      path,
      query: new URL(request.url).searchParams,
      method: request.method,
    });
    operationName = operation.name;
    // Check authorization before decryption, body buffering, refresh or any Google call.
    const initial = await findOwnedConnection({ tx: db, selector, actor });
    connectionId = initial.id;
    const authorize = (row: typeof initial) => {
      if (
        row.connector.key !== connectorKey ||
        !row.connector.enabled ||
        row.status !== "READY" ||
        !calculateEffectiveCapabilities({
          config: row.connector,
          selected: row.selectedScopes,
          granted: row.grantedScopes,
        }).includes(operation.capability)
      )
        throw new ConnectorError(
          "operation_denied",
          "Connection or operation is not available to this caller.",
          403,
        );
    };
    // An existing refresh remains unavailable; never read its credentials on another request.
    if (initial.status !== "REFRESHING") authorize(initial);
    else if (
      !initial.connector.enabled ||
      initial.connector.key !== connectorKey ||
      !calculateEffectiveCapabilities({
        config: initial.connector,
        selected: initial.selectedScopes,
        granted: initial.grantedScopes,
      }).includes(operation.capability)
    )
      throw new ConnectorError("operation_denied", "Operation not allowed.", 403);
    const { credentials, row: credentialState } = await accessCredentials({
      actor,
      selector: initial.id,
    });
    const timeout = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await readBoundedBody({ response: request, maximum: TRANSFER_LIMIT, signal: timeout });
    timeout.throwIfAborted();
    await runConnectorTransaction(async (tx) => {
      const row = await findOwnedConnection({ tx, selector: initial.id, actor });
      authorize(row);
      if (row.version !== credentialState.version)
        throw new ConnectorError(
          "conflict",
          "Connection changed before dispatch. Retry with current state.",
          409,
        );
      const reset = row.rateWindow.getTime() <= Date.now() - 60_000;
      if (!reset && row.rateCount >= 60)
        throw new ConnectorError(
          "rate_limit",
          "Connection request limit exceeded. Retry next minute.",
          429,
        );
      // Usage writes use the current version but do not change configuration/credential versions.
      await tx.connection.update({
        where: { id: row.id, version: row.version },
        data: {
          lastUsedAt: new Date(),
          requestCount: { increment: 1 },
          rateWindow: reset ? new Date() : row.rateWindow,
          rateCount: reset ? 1 : { increment: 1 },
        },
      });
    });
    // Disconnect/disable blocks subsequent authorization. Already-dispatched requests cannot be retroactively cancelled.
    const response = await fetch(operation.target, {
      method: request.method,
      headers: buildUpstreamHeaders({
        input: request.headers,
        accessToken: credentials.accessToken,
      }),
      ...(body ? { body: Buffer.from(body) } : {}),
      redirect: "error",
      signal: timeout,
    });
    const bytes = await readBoundedBody({ response, maximum: TRANSFER_LIMIT, signal: timeout });
    if (response.status === 401)
      await db.connection.updateMany({
        where: { id: initial.id, version: credentialState.version, status: "READY" },
        data: { status: "RECONNECT_REQUIRED", version: { increment: 1 } },
      });
    const headers = new Headers({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    for (const name of responseHeaders) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    await writeConnectorAuditLog({
      tx: db,
      actor,
      event: "request",
      subjectId: initial.id,
      operation: operation.name,
      outcome: response.ok ? "success" : "failed",
      details: {
        connectorId: initial.connectorId,
        accountId: initial.accountId,
        durationMs: Date.now() - started,
        status: response.status,
      },
    });
    return new Response([204, 304].includes(response.status) ? null : Buffer.from(bytes), {
      status: response.status,
      headers,
    });
  } catch (error) {
    await writeConnectorAuditLog({
      tx: db,
      actor,
      event: "request",
      subjectId: connectionId,
      operation: operationName,
      outcome:
        error instanceof ConnectorError && [403, 404].includes(error.status) ? "denied" : "failed",
      details: { durationMs: Date.now() - started },
    });
    throw error;
  }
}
