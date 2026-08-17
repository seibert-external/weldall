import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  webServer: {
    command:
      "pnpm fixture:packed && pnpm --dir .playwright-packed-fixture exec vite preview --config vite.config.js --host 127.0.0.1 --port 4178 --strictPort",
    url: "http://127.0.0.1:4178",
    reuseExistingServer: false,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  use: { baseURL: "http://127.0.0.1:4178", trace: "retain-on-failure" },
});
