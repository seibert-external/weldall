import { db } from "@weldall/db";
import { bootstrapAdmin } from "../server/admin/service";

const emailFlag = process.argv.indexOf("--email");
const email = emailFlag >= 0 ? process.argv[emailFlag + 1] : undefined;
if (!email || process.argv.length !== 4) {
  console.error("Usage: pnpm --filter @weldall/weldall admin:bootstrap --email admin@example.com");
  process.exitCode = 2;
} else {
  try {
    const assignment = await bootstrapAdmin(email);
    console.log(
      `Administrator bootstrap complete for ${assignment.email} (version ${assignment.version}).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Administrator bootstrap failed.");
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
