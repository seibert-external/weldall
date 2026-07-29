import { generateKeyPair, exportJWK } from "jose";
import { randomBytes, randomUUID } from "node:crypto";

const developmentDefaults = {
  NODE_USE_SYSTEM_CA: "1",
  POSTGRES_URL: "postgresql://postgres@localhost:5433/postgres",
  WELDALL_DEPLOYMENT_MODE: "development",
  ENABLE_DEV_LOGIN: "true",
  GOOGLE_CLIENT_ID: '"<<insert or delete line>>"',
  GOOGLE_CLIENT_SECRET: '"<<insert or delete line>>"',
  DEV_IDP_ISSUER: "https://dev-idp.seibert.localdev",
  DEV_IDP_CLIENT_ID: "weldall-dev",
  DEV_IDP_REDIRECT_URI: "http://localhost:3000/api/auth/callback/dev-oidc",
  DEV_IDP_USERS_JSON: `'[{"sub":"dev-alice","email":"alice@example.com","name":"Alice Dev","emailVerified":true}]'`,
};

for (const [name, value] of Object.entries(developmentDefaults)) console.log(`${name}=${value}`);
for (const name of ["WELDALL", "EXPENSES", "DEV_IDP"]) {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  console.log(`${name}_SIGNING_PRIVATE_JWK='${JSON.stringify(await exportJWK(privateKey))}'`);
  console.log(`${name}_SIGNING_PUBLIC_JWK='${JSON.stringify(await exportJWK(publicKey))}'`);
  console.log(`${name}_SIGNING_KID=${randomUUID()}`);
}
console.log(`BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}`);
console.log(`OAUTH_PROXY_SECRET=${randomBytes(32).toString("base64url")}`);
console.log(`WELDALL_CREDENTIAL_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`);
console.log("WELDALL_CREDENTIAL_ENCRYPTION_KEY_VERSION=1");
console.log(`DEV_IDP_CLIENT_SECRET=${randomBytes(32).toString("base64url")}`);
