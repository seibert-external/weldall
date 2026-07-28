import type { ReplayStore } from "./types.js";

let warned = false;

export function inMemory(
  options: { maxEntries?: number; suppressWarning?: boolean } = {},
): ReplayStore {
  const maxEntries = options.maxEntries ?? 10_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
    throw new TypeError("maxEntries must be a positive integer");
  if (!options.suppressWarning && !warned) {
    warned = true;
    console.warn(
      "@weldall/sdk: inMemory() replay protection is process-local and is not safe for horizontally scaled deployments",
    );
  }
  const values = new Map<string, number>();
  return {
    async consume(key, expiresAt) {
      const now = Date.now();
      for (const [candidate, expiry] of values) if (expiry <= now) values.delete(candidate);
      if (!key || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now) return false;
      if (values.has(key)) return false;
      if (values.size >= maxEntries) throw new Error("replay store capacity reached");
      values.set(key, expiresAt.getTime());
      return true;
    },
  };
}

export async function consumeReplay(
  store: ReplayStore | "disabled",
  namespace: "dpop" | "id-jag",
  key: string,
  expiresAt: Date,
  replayError: { code: string; message: string; status?: number },
): Promise<void> {
  if (store === "disabled") return;
  let first: boolean;
  try {
    first = await store.consume(`${namespace}:${key}`, expiresAt);
  } catch {
    const { WeldallAuthError } = await import("./errors.js");
    throw new WeldallAuthError("temporarily_unavailable", "replay protection unavailable", 503);
  }
  if (!first) {
    const { WeldallAuthError } = await import("./errors.js");
    throw new WeldallAuthError(
      replayError.code,
      replayError.message,
      replayError.status ?? 400,
      [],
      "replay_detected",
    );
  }
}
