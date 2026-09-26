import { db, type Prisma } from "@weldall/db";
import { ConnectorError, type AuthorizedConnectorActor } from "../contracts";
import { runConnectorTransaction } from "../configuration";
import { accessCredentials, findOwnedConnection } from "./connections";
import { getConnectorProvider } from "../registry";
import { fingerprintConnectorRequest, writeConnectorAuditLog } from "../audit";
import { assertConnectorAccess } from "../access";
import {
  assertHeaderSize,
  dispatchUpstream,
  filterProxyHeaders,
  parseCanonicalHttps,
  readBoundedBody,
  TRANSFER_LIMIT,
} from "./transport";

/** Authorizes one owner-scoped dispatch. Provider validation is the only route to a trusted target. */
export async function executeConnectionRequest({
  request,
  actor,
  connectorKey,
}: {
  request: Request;
  actor: AuthorizedConnectorActor;
  connectorKey: string;
}) {
  assertHeaderSize(request.headers);
  const selector = request.headers.get("x-weldall-connection");
  if (!selector || selector.length > 160)
    throw new ConnectorError(
      "connection_required",
      "Select a connection using X-Weldall-Connection.",
    );
  if (!/^[A-Z]{1,20}$/.test(request.method))
    throw new ConnectorError("invalid_method", "Invalid request method.");
  const started = Date.now();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
  let connectionId = "unknown";
  let details: { provider?: string; method: string; requestFingerprint?: string } = {
    method: request.method,
  };
  try {
    const initial = await findOwnedConnection({ tx: db, selector, actor });
    assertConnectorAccess({ connector: initial.connector, actor });
    connectionId = initial.id;
    const provider = getConnectorProvider(initial.connector.providerType);
    details = { ...details, provider: provider.type };
    const authorize = (row: typeof initial) => {
      if (row.connector.key !== connectorKey || !row.connector.enabled || row.status !== "READY")
        throw new ConnectorError(
          "connection_denied",
          "Connection is not available to this caller.",
          403,
        );
      provider.validateSetupInput({
        config: row.connector.providerConfig,
        value: row.providerSelection,
      });
    };
    if (initial.status !== "REFRESHING") authorize(initial);
    else if (!initial.connector.enabled || initial.connector.key !== connectorKey)
      throw new ConnectorError(
        "connection_denied",
        "Connection is not available to this caller.",
        403,
      );
    const requestedUrl = parseCanonicalHttps(request.headers.get("x-weldall-upstream-url") ?? "");
    details.requestFingerprint = fingerprintConnectorRequest({
      method: request.method,
      requestedUrl,
    });
    // Reject invalid origins before refreshing or reading provider credentials.
    provider.resolveUpstreamUrl({
      requestedUrl,
      config: initial.connector.providerConfig,
      selection: initial.providerSelection,
      grant: provider.parseGrant(initial.providerGrant),
    });
    const { credentials, row: credentialState } = await accessCredentials({
      actor,
      selector: initial.id,
    });
    authorize(credentialState);
    let grant;
    try {
      grant = await provider.ensureGrantCurrent({
        config: credentialState.connector.providerConfig,
        selection: credentialState.providerSelection,
        credentials,
        previousGrant: provider.parseGrant(credentialState.providerGrant),
      });
    } catch (error) {
      await db.connection.updateMany({
        where: { id: initial.id, version: credentialState.version, status: "READY" },
        data: { status: "RECONNECT_REQUIRED", version: { increment: 1 } },
      });
      throw error;
    }
    const upstreamUrl = provider.resolveUpstreamUrl({
      requestedUrl,
      config: credentialState.connector.providerConfig,
      selection: credentialState.providerSelection,
      grant,
    });
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await readBoundedBody({ response: request, maximum: TRANSFER_LIMIT, signal });
    const headers = filterProxyHeaders({ input: request.headers });
    signal.throwIfAborted();
    await runConnectorTransaction(async (tx) => {
      const row = await findOwnedConnection({ tx, selector: initial.id, actor });
      assertConnectorAccess({ connector: row.connector, actor });
      authorize(row);
      if (
        row.version !== credentialState.version ||
        row.connector.version !== credentialState.connector.version
      )
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
      await tx.connection.update({
        where: { id: row.id, version: row.version },
        data: {
          providerGrant: JSON.parse(JSON.stringify(grant)) as Prisma.InputJsonObject,
          lastUsedAt: new Date(),
          requestCount: { increment: 1 },
          rateWindow: reset ? new Date() : row.rateWindow,
          rateCount: reset ? 1 : { increment: 1 },
        },
      });
    });
    const response = await dispatchUpstream({
      upstreamUrl,
      signal,
      init: provider.buildUpstreamRequest({
        upstreamUrl,
        credentials,
        request: {
          requestedUrl,
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
        },
        signal,
      }),
    });
    // A 401 blocks credentials even if response buffering subsequently fails.
    if (response.status === 401)
      await db.connection.updateMany({
        where: { id: initial.id, version: credentialState.version, status: "READY" },
        data: { status: "RECONNECT_REQUIRED", version: { increment: 1 } },
      });
    let responseHeaders: Headers;
    try {
      responseHeaders = filterProxyHeaders({ input: response.headers, response: true });
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    const bytes = await readBoundedBody({ response, maximum: TRANSFER_LIMIT, signal });
    responseHeaders.set("cache-control", "no-store");
    responseHeaders.set("x-content-type-options", "nosniff");
    await writeConnectorAuditLog({
      tx: db,
      actor,
      event: "request",
      subjectId: initial.id,
      operation: "proxy.request",
      outcome: response.ok ? "success" : "failed",
      details: {
        ...details,
        connectorId: initial.connectorId,
        durationMs: Date.now() - started,
        status: response.status,
      },
    });
    return new Response(
      request.method === "HEAD" || [204, 205, 304].includes(response.status)
        ? null
        : Buffer.from(bytes),
      { status: response.status, headers: responseHeaders },
    );
  } catch (error) {
    await writeConnectorAuditLog({
      tx: db,
      actor,
      event: "request",
      subjectId: connectionId,
      operation: "proxy.request",
      outcome:
        error instanceof ConnectorError && [403, 404].includes(error.status) ? "denied" : "failed",
      details: { ...details, durationMs: Date.now() - started },
    });
    throw error;
  }
}
