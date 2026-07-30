import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertDeploymentModeMatches,
  parseResetMode,
  seedScriptsForMode,
} from "./hard-reset-options";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const mode = parseResetMode(process.argv.slice(2));
assertDeploymentModeMatches(mode, process.env.WELDALL_DEPLOYMENT_MODE);
if (!process.env.POSTGRES_URL) {
  throw new Error("POSTGRES_URL is required.");
}

const run = (args: string[]) =>
  execFileSync("pnpm", args, {
    cwd: packageRoot,
    env: { ...process.env, WELDALL_DEPLOYMENT_MODE: mode },
    stdio: "inherit",
  });

console.warn(`Hard-resetting the ${mode} database. All existing data will be deleted.`);
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
for (const seedScript of seedScriptsForMode(mode)) run(["exec", "tsx", seedScript]);
console.info(
  `${mode === "development" ? "Development" : "Production"} database reset and seeded successfully.`,
);
