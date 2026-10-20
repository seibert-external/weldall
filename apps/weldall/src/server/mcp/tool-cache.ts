import { createHash } from "node:crypto";
import { MCP_LIMITS, McpBoundaryError } from "@weldall/sdk/mcp";
import { ConnectorError } from "../connectors/errors";
import type { AuthorizedConnectionUse } from "../connectors/core/authorization";
import type { discoverMcpTools } from "./discovery";

export type ToolCatalog = Awaited<ReturnType<typeof discoverMcpTools>>;
export type ToolCacheStatus = "hit" | "miss" | "coalesced";
export interface McpToolCache<T = ToolCatalog> {
  getOrLoad(input: {
    key: string;
    signal: AbortSignal;
    /** Must return a complete, schema/size-validated and credential-safe catalog. */
    load(signal: AbortSignal): Promise<T>;
    onStatus(status: ToolCacheStatus): void;
  }): Promise<T>;
}

/** Usage counters/timestamps do not invalidate catalogs; lifecycle writes increment versions. */
export function toolCatalogKey(connection: AuthorizedConnectionUse): string {
  const { row, grant } = connection;
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.connectorId,
        row.connector.version,
        row.id,
        row.version,
        row.credentialId,
        grant,
      ]),
    )
    .digest("hex");
}

function cancelled(signal: AbortSignal) {
  return new McpBoundaryError(signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled");
}

type Entry = { json: string; bytes: number; expiresAt: number };
type Flight = { controller: AbortController; promise: Promise<string>; waiters: number };

export function createMemoryMcpToolCache<T = ToolCatalog>({
  ttlMs = 5 * 60_000,
  maxEntries = 128,
  maxBytes = 16 * 1024 * 1024,
  maxInFlight = 100,
  now = () => performance.now(),
}: {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxInFlight?: number;
  now?: () => number;
} = {}): McpToolCache<T> {
  for (const value of [ttlMs, maxEntries, maxBytes, maxInFlight])
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid MCP cache bound.");
  const entries = new Map<string, Entry>();
  const flights = new Map<string, Flight>();
  let bytes = 0;
  let inFlight = 0;
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (entry) bytes -= entry.bytes;
    entries.delete(key);
  };

  return {
    async getOrLoad(input) {
      if (input.signal.aborted) throw cancelled(input.signal);
      for (const [key, entry] of entries) if (entry.expiresAt <= now()) remove(key);
      const cached = entries.get(input.key);
      if (cached) {
        entries.delete(input.key);
        entries.set(input.key, cached);
        input.onStatus("hit");
        // Keep a serialized snapshot, never a shared mutable object or a credential/session closure.
        return JSON.parse(cached.json) as T;
      }
      let flight = flights.get(input.key);
      input.onStatus(flight ? "coalesced" : "miss");
      if (!flight) {
        if (inFlight >= maxInFlight)
          throw new ConnectorError("rate_limit", "Too many concurrent MCP discoveries.", 429);
        const controller = new AbortController();
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(MCP_LIMITS.operationMs),
        ]);
        inFlight++;
        const promise = Promise.resolve()
          .then(() => {
            if (signal.aborted) throw cancelled(signal);
            return input.load(signal);
          })
          .then((catalog) => {
            if (signal.aborted) throw cancelled(signal);
            const json = JSON.stringify(catalog);
            const size = Buffer.byteLength(json, "utf8");
            if (size <= maxBytes) {
              while (entries.size >= maxEntries || bytes + size > maxBytes)
                remove(entries.keys().next().value!);
              entries.set(input.key, { json, bytes: size, expiresAt: now() + ttlMs });
              bytes += size;
            }
            return json;
          })
          .finally(() => {
            inFlight--;
            if (flights.get(input.key)?.controller === controller) flights.delete(input.key);
          });
        flight = { controller, waiters: 0, promise };
        flights.set(input.key, flight);
      }
      const shared = flight;
      shared.waiters++;
      let abort: () => void;
      return new Promise<string>((resolve, reject) => {
        abort = () => reject(cancelled(input.signal));
        input.signal.addEventListener("abort", abort, { once: true });
        if (input.signal.aborted) abort();
        shared.promise.then(resolve, reject);
      })
        .then((json) => JSON.parse(json) as T)
        .finally(() => {
          input.signal.removeEventListener("abort", abort);
          shared.waiters--;
          if (!shared.waiters && flights.get(input.key) === shared) {
            flights.delete(input.key);
            shared.controller.abort();
          }
        });
    },
  };
}

export const mcpToolCache = createMemoryMcpToolCache();
