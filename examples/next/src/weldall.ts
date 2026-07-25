import { inMemory } from "@weldall/sdk";
import { initWeldall } from "@weldall/sdk/next";
import { developmentKey } from "./development-key";

export const weldall = initWeldall("https://weldall.example.com", {
  resource: "http://localhost:3000/api",
  publicOrigin: "http://localhost:3000",
  clientId: "weldall-cli-at-next",
  supportedScopes: ["expenses:read"],
  signingKey: developmentKey,
  replayStore: inMemory(),
  allowInsecureLoopback: true,
});
