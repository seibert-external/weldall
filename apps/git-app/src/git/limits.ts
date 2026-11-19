/**
 * Operating limits of the git proxy (carried over unchanged from the server's
 * `git-proxy/limits.ts`). Git traffic is streamed; nothing here buffers a pack.
 */
export const GIT_PROXY_LIMITS = {
  /** Request body of one push. A realistic publish is below 1 MiB; the whole template ~400 KiB. */
  pushMaxBytes: 100 * 1024 * 1024,
  /**
   * Response body of one fetch. Bounds bandwidth for clones of grown repositories; a full clone
   * of a 906 MiB test branch took 22-30 s.
   */
  fetchMaxBytes: 1024 * 1024 * 1024,
  /** Shallow lines, ref update commands and push options before the pack. */
  commandListMaxBytes: 64 * 1024,
  /**
   * Whole request, upload and response. Below Node's default 300 s `requestTimeout` of the HTTP
   * server, so a slow push ends with the Git app's message instead of Node's bare 408.
   */
  transferTimeoutMs: 280_000,
  /** Forwarded requests in this process. */
  maxConcurrentTransfers: 16,
  maxConcurrentTransfersPerUser: 4,
  /** Seconds a client should wait after a concurrency refusal. */
  retryAfterSeconds: 10,
} as const;

export type GitProxyLimits = { -readonly [K in keyof typeof GIT_PROXY_LIMITS]: number };

/**
 * In-process semaphore for concurrent transfers, globally and per person (one instance is one
 * process). `acquire` returns a release function, or which limit refused the transfer.
 */
export function createTransferLimiter(
  limits: Pick<GitProxyLimits, "maxConcurrentTransfers" | "maxConcurrentTransfersPerUser">,
) {
  let active = 0;
  const perUser = new Map<string, number>();
  return {
    acquire(userId: string): { release: () => void } | { refused: "global" | "user" } {
      if (active >= limits.maxConcurrentTransfers) return { refused: "global" };
      const mine = perUser.get(userId) ?? 0;
      if (mine >= limits.maxConcurrentTransfersPerUser) return { refused: "user" };
      active += 1;
      perUser.set(userId, mine + 1);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          active -= 1;
          const left = (perUser.get(userId) ?? 1) - 1;
          if (left > 0) perUser.set(userId, left);
          else perUser.delete(userId);
        },
      };
    },
    get active() {
      return active;
    },
  };
}
export type TransferLimiter = ReturnType<typeof createTransferLimiter>;
