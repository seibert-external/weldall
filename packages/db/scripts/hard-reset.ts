import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

if (process.env.WELDALL_DEPLOYMENT_MODE !== "development") {
  throw new Error("Hard database reset is allowed only when WELDALL_DEPLOYMENT_MODE=development.");
}
if (!process.env.POSTGRES_URL) {
  throw new Error("POSTGRES_URL is required.");
}

const run = (args: string[]) =>
  execFileSync("pnpm", args, {
    cwd: packageRoot,
    env: process.env,
    stdio: "inherit",
  });

console.warn("Hard-resetting the development database. All existing data will be deleted.");
run([
  "exec",
  "prisma",
  "migrate",
  "reset",
  "--force",
  "--skip-seed",
  "--schema",
  "prisma/schema.prisma",
]);
run(["exec", "tsx", "prisma/seed.ts"]);
run(["exec", "tsx", "prisma/seed.dev.ts"]);
console.info("Development database reset and seeded successfully.");
