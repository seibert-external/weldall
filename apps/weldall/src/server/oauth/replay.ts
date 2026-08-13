import { db } from "@weldall/db";
import type { ReplayStore } from "@weldall/sdk";

const CLEANUP_BATCH = 1_000;

/** Construct a PostgreSQL-backed replay store shared with every Weldall process. */
export function createPostgresReplayStore(): ReplayStore {
  let lastCleanup = 0;
  return {
    async consume(key, expiresAt) {
      const now = new Date();
      if (!key || key.length > 500 || !Number.isFinite(expiresAt.getTime()) || expiresAt <= now)
        return false;

      // Bounded, opportunistic cleanup avoids an unbounded hot-path delete.
      if (Date.now() - lastCleanup > 60_000) {
        lastCleanup = Date.now();
        const expired = await db.replayMarker.findMany({
          where: { expiresAt: { lte: now } },
          orderBy: { expiresAt: "asc" },
          take: CLEANUP_BATCH,
          select: { key: true },
        });
        if (expired.length)
          await db.replayMarker.deleteMany({
            where: { key: { in: expired.map(({ key }) => key) } },
          });
      }

      const inserted = await db.$executeRaw`
        INSERT INTO "ReplayMarker" ("key", "expiresAt")
        VALUES (${key}, ${expiresAt})
        ON CONFLICT ("key") DO NOTHING
      `;
      return inserted === 1;
    },
  };
}

export const postgresReplayStore = createPostgresReplayStore();
