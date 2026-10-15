import { db } from "@weldall/db";
import { ConnectorError, type AuthorizedConnectorActor } from "../contracts";
import { logger } from "../../observability/logger";
import { fingerprintConnectorRequest, writeConnectorAuditLog } from "../audit";
import { authorizeConnectionUse } from "./authorization";
import {
  assertHeaderSize,
  dispatchUpstream,
  filterProxyHeaders,
  parseCanonicalHttps,
  readBoundedBody,
  TRANSFER_LIMIT,
} from "./transport";

/** HTTP proxy and MCP share the owner/quota/refresh/version authorization boundary. */
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
    const requestedUrl = parseCanonicalHttps(request.headers.get("x-weldall-upstream-url") ?? "");
    details.requestFingerprint = fingerprintConnectorRequest({
      method: request.method,
      requestedUrl,
    });
    return await authorizeConnectionUse({
      actor,
      selector,
      connectorKey,
      signal,
      preflight(row, provider) {
        connectionId = row.id;
        details = { ...details, provider: provider.type };
        provider.resolveUpstreamUrl({
          requestedUrl,
          config: row.connector.providerConfig,
          selection: row.providerSelection,
          grant: provider.parseGrant(row.providerGrant),
        });
      },
      async run({ row, provider, credentials, grant, assertCurrent }) {
        const upstreamUrl = provider.resolveUpstreamUrl({
          requestedUrl,
          config: row.connector.providerConfig,
          selection: row.providerSelection,
          grant,
        });
        const body =
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await readBoundedBody({ response: request, maximum: TRANSFER_LIMIT, signal });
        const headers = filterProxyHeaders({ input: request.headers });
        await assertCurrent();
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
        if (!response.ok)
          logger.warn(
            {
              event: "connector.request.upstream_failed",
              provider: provider.type,
              connectorId: row.connectorId,
              connectionId: row.id,
              method: request.method,
              requestFingerprint: details.requestFingerprint,
              status: response.status,
              atlTraceId: response.headers.get("atl-traceid") ?? undefined,
              atlassianRequestId: response.headers.get("x-arequestid") ?? undefined,
            },
            "Connector upstream request failed",
          );
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
          subjectId: row.id,
          operation: "proxy.request",
          outcome: response.ok ? "success" : "failed",
          details: {
            ...details,
            connectorId: row.connectorId,
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
      },
    });
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
