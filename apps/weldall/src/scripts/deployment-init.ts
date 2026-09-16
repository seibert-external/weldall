import { db } from "@weldall/db";
import { prepareProductionDatabase } from "../server/deployment";
import { errorForLog, logger } from "../server/observability/logger";
import { refreshDueCatalogs } from "../server/skills/catalogs";

logger.info({ event: "deployment_init.started" }, "Deployment initialization started");
try {
  if (process.env.WELDALL_DEPLOYMENT_MODE === "production") {
    await prepareProductionDatabase();
  }

  await refreshDueCatalogs();

  logger.info({ event: "deployment_init.completed" }, "Deployment initialization completed");
} catch (error) {
  logger.fatal(
    { event: "deployment_init.failed", error: errorForLog(error) },
    "Deployment initialization failed",
  );
  throw error;
} finally {
  await db.$disconnect();
}
