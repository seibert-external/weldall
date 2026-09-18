import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __WELDALL_TEST_BUILD__: "true",
  },
});
