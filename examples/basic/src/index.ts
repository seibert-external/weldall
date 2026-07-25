import { generateEs256KeyPair, inMemory, initWeldall } from "@weldall/sdk";

const key = await generateEs256KeyPair();
export const weldall = initWeldall("https://weldall.example.com", {
  resource: "https://api.example.com/api",
  publicOrigin: "https://api.example.com",
  clientId: "weldall-cli-at-api",
  supportedScopes: ["api:read"],
  signingKey: { kid: "development-only", privateJwk: key.privateJwk, publicJwk: key.publicJwk },
  replayStore: inMemory(),
});

export const verify = (request: Request) => weldall.verify(request, { scopes: ["api:read"] });
export const verifyNoThrow = (request: Request) =>
  weldall.verifyNoThrow(request, { scopes: ["api:read"] });
