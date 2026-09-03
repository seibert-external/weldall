import { readFileSync } from "node:fs";
import { calculateJwkThumbprint } from "jose";
import {
  createDpopProof,
  generateEs256KeyPair,
  issueAccessToken,
  normalizeHtu,
  signEs256,
  verifyAccessToken,
  verifyEs256,
  verifyStrictDpop,
} from "../../../sdk/src/index.ts";

const issuer = "https://interop.example";
const resource = "https://interop.example/api";
const clientId = "interop-client";
const url = "https://INTEROP.example:443/api/a//../items?ignored=yes";

if (process.argv[2] === "generate") {
  const signing = await generateEs256KeyPair();
  const device = await generateEs256KeyPair();
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await issueAccessToken({
    issuer,
    subject: "interop-user",
    email: "interop@example.com",
    resource,
    clientId,
    scopes: ["interop:read"],
    jkt: device.jkt,
    kid: "node-signing",
    privateJwk: signing.privateJwk,
    now,
  });
  const genericJwt = await signEs256(
    { iss: issuer, aud: resource, iat: now, exp: now + 300, source: "node" },
    { kid: "node-signing", privateJwk: signing.privateJwk },
  );
  const proof = await createDpopProof({
    ...device,
    method: "GET",
    url,
    accessToken,
    now,
    jti: "node-proof",
  });
  process.stdout.write(
    JSON.stringify({
      issuer,
      resource,
      clientId,
      url,
      signingPublicJwk: signing.publicJwk,
      devicePublicJwk: device.publicJwk,
      deviceJkt: device.jkt,
      accessToken,
      genericJwt,
      proof,
    }),
  );
} else if (process.argv[2] === "normalize") {
  const input = JSON.parse(readFileSync(0, "utf8")) as { urls: string[] };
  process.stdout.write(JSON.stringify({ urls: input.urls.map((value) => normalizeHtu(value)) }));
} else if (process.argv[2] === "verify") {
  const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, any>;
  const generic = await verifyEs256(input.genericJwt, {
    issuer,
    audience: resource,
    kid: "python-signing",
    publicJwk: input.signingPublicJwk,
  });
  if (generic.source !== "python") throw new Error("Python generic JWT claims mismatch");
  const access = await verifyAccessToken(input.accessToken, {
    issuer,
    resource,
    clientId,
    kid: "python-signing",
    publicJwk: input.signingPublicJwk,
    requiredScopes: ["interop:read"],
  });
  if (access.sub !== "interop-user" || access.scope !== "interop:read") {
    throw new Error("Python access token claims mismatch");
  }
  const proof = await verifyStrictDpop(input.proof, {
    method: "GET",
    url,
    replay: "disabled",
    accessToken: input.accessToken,
    expectedJkt: input.deviceJkt,
  });
  if ((await calculateJwkThumbprint(input.devicePublicJwk, "sha256")) !== input.deviceJkt) {
    throw new Error("Python JWK thumbprint mismatch");
  }
  if (proof.jkt !== input.deviceJkt) throw new Error("Python DPoP proof key mismatch");
  process.stdout.write(JSON.stringify({ ok: true }));
} else {
  throw new Error("expected generate or verify");
}
