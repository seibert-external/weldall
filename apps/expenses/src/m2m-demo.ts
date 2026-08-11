import { calculateJwkThumbprint } from "jose";
import { createDpopProof, loadEs256KeyPairFromEnv, requestMachineToken } from "@weldall/sdk";
import { EXPENSES_RESOURCE, WELDALL_ISSUER } from "./constants.js";

const clientId = "dev-expenses-reader";
const kid = requiredEnv("DEV_M2M_SIGNING_KID");
const pair = await loadEs256KeyPairFromEnv({
  privateName: "DEV_M2M_SIGNING_PRIVATE_JWK",
  privateValue: process.env.DEV_M2M_SIGNING_PRIVATE_JWK,
  publicName: "DEV_M2M_SIGNING_PUBLIC_JWK",
  publicValue: process.env.DEV_M2M_SIGNING_PUBLIC_JWK,
});
const key = {
  ...pair,
  jkt: await calculateJwkThumbprint(pair.publicJwk, "sha256"),
};
const token = await requestMachineToken({
  issuer: WELDALL_ISSUER,
  clientId,
  resource: EXPENSES_RESOURCE,
  scopes: ["expenses:read"],
  kid,
  key,
});
const target = `${EXPENSES_RESOURCE}/expenses`;
const proof = await createDpopProof({
  ...key,
  method: "GET",
  url: target,
  accessToken: token.accessToken,
});
const response = await fetch(target, {
  headers: {
    authorization: `DPoP ${token.accessToken}`,
    dpop: proof,
  },
  redirect: "error",
});
const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
if (!response.ok) {
  throw new Error(`Expenses rejected the development machine request (${response.status}).`);
}
if (
  body?.identityType !== "machine" ||
  body.requestedBy !== clientId ||
  body.subject !== `machine:${clientId}`
) {
  throw new Error("Expenses returned an unexpected machine identity.");
}

console.log(JSON.stringify(body, null, 2));

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required. Generate .env with pnpm secrets:generate.`);
  return value;
}
