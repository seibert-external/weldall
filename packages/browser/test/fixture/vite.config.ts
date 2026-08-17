import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname),
  server: { host: "127.0.0.1", port: 4178, strictPort: true },
  build: { outDir: resolve(import.meta.dirname, "built"), emptyOutDir: true },
});
