import { createHash } from "node:crypto";
import type { ResourceRegistryEntry } from "@weldall/sdk";
import { validateNativeMcpMetadata, type NativeMcpMetadata } from "@weldall/sdk/mcp";

import { createMemoryMcpToolCache } from "./tool-cache";

const metadataCache = createMemoryMcpToolCache<NativeMcpMetadata>({ ttlMs: 60_000 });

/** Only SDK metadata at a registered origin may define native discovery policy. */
export async function authorizedNativeResources(
  resources: Omit<ResourceRegistryEntry, "grantedScopes">[],
  grants: readonly string[],
): Promise<Map<string, NativeMcpMetadata>> {
  const eligible = resources.filter((resource) =>
    resource.supportedScopes.some((scope) => grants.includes(scope)),
  );
  const signal = AbortSignal.timeout(5_000);
  const allowed = new Map<string, NativeMcpMetadata>();
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, eligible.length) }, async () => {
      while (index < eligible.length && !signal.aborted) {
        const resource = eligible[index++]!;
        try {
          const key = createHash("sha256")
            .update(
              JSON.stringify([
                resource.key,
                resource.resourceIdentifier,
                resource.authorizationServer,
                resource.downstreamClientId,
                [...resource.requestPrefixes].sort(),
                [...resource.supportedScopes].sort(),
              ]),
            )
            .digest("hex");
          const metadata = await metadataCache.getOrLoad({
            key,
            signal,
            onStatus: () => {},
            async load(sharedSignal) {
              const signal = AbortSignal.any([sharedSignal, AbortSignal.timeout(5_000)]);
              const response = await fetch(
                `${resource.authorizationServer}/.well-known/oauth-protected-resource`,
                {
                  headers: { accept: "application/json" },
                  redirect: "error",
                  signal,
                },
              );
              const reader = response.body?.getReader();
              try {
                if (
                  !response.ok ||
                  !reader ||
                  Number(response.headers.get("content-length") ?? 0) > 65_536
                )
                  throw new Error("metadata_unavailable");
                const chunks: Uint8Array[] = [];
                let size = 0;
                for (;;) {
                  signal.throwIfAborted();
                  const part = await reader.read();
                  if (part.done) break;
                  size += part.value.byteLength;
                  if (size > 65_536) throw new Error("metadata_too_large");
                  chunks.push(part.value);
                }
                return validateNativeMcpMetadata(
                  resource,
                  JSON.parse(Buffer.concat(chunks).toString("utf8")),
                );
              } finally {
                await reader?.cancel().catch(() => {});
              }
            },
          });
          // Cache definitions, never the caller's authorization decision.
          if (metadata.discoveryScopes.every((scope) => grants.includes(scope)))
            allowed.set(resource.key, metadata);
        } catch {
          // Missing, stale, invalid, or unreachable metadata never implies discovery access.
        }
      }
    }),
  );
  return allowed;
}

export async function authorizedNativeResourceKeys(
  resources: Omit<ResourceRegistryEntry, "grantedScopes">[],
  grants: readonly string[],
): Promise<string[]> {
  return [...(await authorizedNativeResources(resources, grants)).keys()];
}
