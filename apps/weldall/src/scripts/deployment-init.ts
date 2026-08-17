import { db } from "@weldall/db";
import { bootstrapConfiguredAdmin, prepareProductionDatabase } from "../server/deployment";
import { errorForLog, logger } from "../server/observability/logger";
import { refreshDueCatalogs } from "../server/skills/catalogs";
import { reconcileAllBrowserIssuancesAtStartup } from "../server/oauth/browser-issuance";

logger.info({ event: "deployment_init.started" }, "Deployment initialization started");
try {
  if (process.env.WELDALL_DEPLOYMENT_MODE === "production") {
    await prepareProductionDatabase();
  }

  await reconcileAllBrowserIssuancesAtStartup();
  await refreshDueCatalogs();

  const email = process.env.WELDALL_BOOTSTRAP_ADMIN_EMAIL?.trim();
  if (email) {
    const assignment = await bootstrapConfiguredAdmin(email);
    if (assignment) {
      logger.info(
        {
          event: "deployment_init.admin_bootstrapped",
          assignmentVersion: assignment.version,
        },
        "Administrator bootstrap complete",
      );
    }
  }
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
