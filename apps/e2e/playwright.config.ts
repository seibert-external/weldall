import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const artifacts = process.env.PLAYWRIGHT_ARTIFACTS_DIR ?? "test-results";

export default defineConfig({
  testDir: "./test",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: join(artifacts, "playwright"),
  use: {
    trace: "off",
    screenshot: "off",
  },
  reporter: [["line"], ["junit", { outputFile: join(artifacts, "junit.xml") }]],
});
