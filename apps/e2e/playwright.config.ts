import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const artifacts = process.env.PLAYWRIGHT_ARTIFACTS_DIR ?? "test-results";

export default defineConfig({
  testDir: "./test",
  // Blocks until every public dependency the suite talks to actually serves, and
  // fails the run naming the dependency, instead of letting the first test
  // discover it through a navigation or auth error.
  globalSetup: "./readiness-gate.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  // Explicit expect timeouts in the scenarios are unchanged; the readiness gate
  // above is what removes the cold-start timing they were compensating for.
  expect: { timeout: 30_000 },
  outputDir: join(artifacts, "playwright"),
  use: {
    trace: "off",
    screenshot: "off",
  },
  reporter: [["line"], ["junit", { outputFile: join(artifacts, "junit.xml") }]],
});
