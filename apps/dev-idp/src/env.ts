import { loadEs256KeyPairFromEnv } from "@weldall/sdk";
import type { JWK } from "jose";
import { z } from "zod";

const userSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  emailVerified: z.boolean(),
});

const schema = z.object({
  DEV_IDP_ISSUER: z.string().url(),
  DEV_IDP_CLIENT_ID: z.string().min(1),
  DEV_IDP_CLIENT_SECRET: z.string().min(16),
  WELDALL_ISSUER: z.string().url().default("https://weldall.seibert.localdev"),
  DEV_IDP_SIGNING_PRIVATE_JWK: z.string(),
  DEV_IDP_SIGNING_PUBLIC_JWK: z.string(),
  DEV_IDP_SIGNING_KID: z.string().min(1),
  DEV_IDP_USERS_JSON: z.string(),
});

export type DevIdpUser = z.infer<typeof userSchema>;
export type DevIdpEnv = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  callbackOrigin: string;
  signingKid: string;
  privateJwk: JWK;
  publicJwk: JWK;
  users: DevIdpUser[];
};

export async function getEnv(source: NodeJS.ProcessEnv = process.env): Promise<DevIdpEnv> {
  const value = schema.parse(source);
  const issuer = new URL(value.DEV_IDP_ISSUER);
  const redirect = new URL(value.WELDALL_ISSUER);
  if (issuer.protocol !== "https:" || issuer.pathname !== "/" || issuer.search || issuer.hash)
    throw new Error("DEV_IDP_ISSUER must be an HTTPS origin");
  if (
    redirect.protocol !== "https:" ||
    redirect.pathname !== "/" ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  )
    throw new Error("WELDALL_ISSUER must be an HTTPS origin");
  const keyPair = await loadEs256KeyPairFromEnv({
    privateName: "DEV_IDP_SIGNING_PRIVATE_JWK",
    privateValue: value.DEV_IDP_SIGNING_PRIVATE_JWK,
    publicName: "DEV_IDP_SIGNING_PUBLIC_JWK",
    publicValue: value.DEV_IDP_SIGNING_PUBLIC_JWK,
  });
  const users = z.array(userSchema).min(1).parse(JSON.parse(value.DEV_IDP_USERS_JSON));
  if (new Set(users.map((user) => user.sub)).size !== users.length)
    throw new Error("DEV_IDP_USERS_JSON contains duplicate subjects");
  if (new Set(users.map((user) => user.email.toLowerCase())).size !== users.length)
    throw new Error("DEV_IDP_USERS_JSON contains duplicate emails");
  return {
    issuer: issuer.origin,
    clientId: value.DEV_IDP_CLIENT_ID,
    clientSecret: value.DEV_IDP_CLIENT_SECRET,
    callbackOrigin: redirect.origin,
    signingKid: value.DEV_IDP_SIGNING_KID,
    privateJwk: keyPair.privateJwk,
    publicJwk: keyPair.publicJwk,
    users,
  };
}
