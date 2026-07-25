import { generateEs256KeyPair, inMemory, signEs256 } from "@weldall/sdk";
import { initWeldall } from "@weldall/sdk/astro";

const key = generateEs256KeyPair();
export const weldall = initWeldall("https://weldall.example.com", {
  resource: "http://localhost:4321/api",
  publicOrigin: "http://localhost:4321",
  clientId: "weldall-cli-at-astro",
  supportedScopes: ["expenses:read"],
  signingKey: {
    async current() {
      const value = await key;
      return {
        kid: "development-only",
        publicJwk: value.publicJwk,
        sign: (payload, header) =>
          signEs256(payload, { kid: header.kid, privateJwk: value.privateJwk, typ: header.typ }),
      };
    },
    async jwks() {
      const value = await key;
      return [{ ...value.publicJwk, kid: "development-only", alg: "ES256", use: "sig" }];
    },
  },
  replayStore: inMemory(),
  allowInsecureLoopback: true,
});
