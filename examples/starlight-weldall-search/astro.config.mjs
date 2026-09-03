import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import node from "@astrojs/node";
import { weldallSearch } from "@weldall/sdk/starlight";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [
    starlight({
      title: "Basics Demo",
    }),
    weldallSearch("https://weldall.example.com", {
      publicOrigin: "http://localhost:4321",
      resource: "http://localhost:4321/api",
      clientId: "starlight-demo",
      requiredScopes: ["search:read"],
    }),
  ],
});
