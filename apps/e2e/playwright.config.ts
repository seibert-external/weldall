import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const artifacts = process.env.PLAYWRIGHT_ARTIFACTS_DIR ?? "test-results";

export default defineConfig({
  testDir: "./test",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  // Generous default so cold dev-server route compiles (observed up to ~35s on
  // loaded CI runners) do not trip assertions that did not set an explicit timeout.
  expect: { timeout: 30_000 },
  outputDir: join(artifacts, "playwright"),
  use: {
    trace: "off",
    screenshot: "off",
  },
  reporter: [["line"], ["junit", { outputFile: join(artifacts, "junit.xml") }]],
});
