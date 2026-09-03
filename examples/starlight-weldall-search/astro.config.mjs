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
      // The consumer sources the key however they like — values only, no
      // environment-variable names. Fallback: process.env.WELDALL_SIGNING_KEY.
      // signingKey: JSON.parse(process.env.MY_SIGNING_KEY),
    }),
  ],
});
