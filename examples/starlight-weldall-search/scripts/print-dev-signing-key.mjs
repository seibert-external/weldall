import { generateEs256KeyPair } from "@weldall/sdk";

const key = await generateEs256KeyPair();

process.stdout.write(
  JSON.stringify({
    kid: "local-dev",
    privateJwk: key.privateJwk,
    publicJwk: key.publicJwk,
  }),
);
