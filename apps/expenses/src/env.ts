import { z } from "zod";
import { assertPublicP256, loadEs256KeyPairFromEnv, parseJwkEnv } from "@weldall/oauth";
const schema = z.object({
  EXPENSES_SIGNING_PRIVATE_JWK: z.string(),
  EXPENSES_SIGNING_PUBLIC_JWK: z.string(),
  EXPENSES_SIGNING_KID: z.string().min(1),
  WELDALL_SIGNING_PUBLIC_JWK: z.string(),
  WELDALL_SIGNING_KID: z.string().min(1),
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
  return {
    ...e,
    expensesPrivateJwk: expensesKey.privateJwk,
    expensesPublicJwk: expensesKey.publicJwk,
    weldallPublicJwk,
  };
};
