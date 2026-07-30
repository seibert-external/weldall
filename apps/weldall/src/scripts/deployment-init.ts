import { db } from "@weldall/db";
import { bootstrapAdmin } from "../server/admin/service";
import { prepareProductionDatabase } from "../server/deployment";
import { refreshDueCatalogs } from "../server/skills/catalogs";

try {
  if (process.env.WELDALL_DEPLOYMENT_MODE === "production") {
    await prepareProductionDatabase();
  }

  await refreshDueCatalogs();

  const email = process.env.WELDALL_BOOTSTRAP_ADMIN_EMAIL?.trim();
  if (email) {
    const assignment = await bootstrapAdmin(email);
    console.log(
      `Administrator bootstrap complete for ${assignment.email} (version ${assignment.version}).`,
    );
  }
} finally {
  await db.$disconnect();
}
