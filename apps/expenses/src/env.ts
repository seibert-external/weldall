import { z } from "zod";
import {
  DOWNSTREAM_CLIENT_ID,
  EXPENSES_ISSUER,
  EXPENSES_RESOURCE,
  assertPublicP256,
  loadEs256KeyPairFromEnv,
  parseJwkEnv,
} from "@weldall/oauth";
const schema = z.object({
  EXPENSES_SIGNING_PRIVATE_JWK: z.string(),
  EXPENSES_SIGNING_PUBLIC_JWK: z.string(),
  EXPENSES_SIGNING_KID: z.string().min(1),
  WELDALL_SIGNING_PUBLIC_JWK: z.string(),
  WELDALL_SIGNING_KID: z.string().min(1),
  DOWNSTREAM_ISSUER: z.string().url().optional(),
  DOWNSTREAM_RESOURCE_IDENTIFIER: z.string().url().optional(),
  DOWNSTREAM_CLIENT_ID: z.string().min(1).optional(),
  DOWNSTREAM_SCOPES: z.string().min(1).optional(),
});
export const getEnv = async () => {
  const e = schema.parse(process.env);
  const expensesKey = await loadEs256KeyPairFromEnv({
    privateName: "EXPENSES_SIGNING_PRIVATE_JWK",
    privateValue: e.EXPENSES_SIGNING_PRIVATE_JWK,
    publicName: "EXPENSES_SIGNING_PUBLIC_JWK",
    publicValue: e.EXPENSES_SIGNING_PUBLIC_JWK,
  });
  const weldallPublicJwk = parseJwkEnv("WELDALL_SIGNING_PUBLIC_JWK", e.WELDALL_SIGNING_PUBLIC_JWK);
  await assertPublicP256(weldallPublicJwk);
  const issuer = e.DOWNSTREAM_ISSUER ?? EXPENSES_ISSUER;
  return {
    ...e,
    downstreamIssuer: issuer,
    downstreamResourceIdentifier:
      e.DOWNSTREAM_RESOURCE_IDENTIFIER ??
      (e.DOWNSTREAM_ISSUER ? `${issuer}/api` : EXPENSES_RESOURCE),
    downstreamClientId: e.DOWNSTREAM_CLIENT_ID ?? DOWNSTREAM_CLIENT_ID,
    downstreamScopes: (
      e.DOWNSTREAM_SCOPES ?? "expenses:read expenses:create expenses:delete expenses:write"
    )
      .split(/\s+/)
      .filter(Boolean),
    expensesPrivateJwk: expensesKey.privateJwk,
    expensesPublicJwk: expensesKey.publicJwk,
    weldallPublicJwk,
  };
};
