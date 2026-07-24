import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";

const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error("usage: generate-e2e-env <output-directory>");

const generateEs256KeyPair = async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  return { privateJwk, publicJwk, jkt: await calculateJwkThumbprint(publicJwk) };
};
const [weldall, expenses, devIdp] = await Promise.all([
  generateEs256KeyPair(),
  generateEs256KeyPair(),
  generateEs256KeyPair(),
]);
const secret = () => randomBytes(32).toString("base64url");
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const postgresUrl = "postgresql://postgres:postgres@postgres:5432/postgres";
const devIdpClientSecret = secret();
const devUsers = JSON.stringify([
  {
    sub: "dev-alice",
    email: "alice@example.com",
    name: "Alice E2E",
    emailVerified: true,
  },
]);

const files: Record<string, Record<string, string>> = {
  "database/env.sh": { POSTGRES_URL: postgresUrl },
  "weldall/env.sh": {
    POSTGRES_URL: postgresUrl,
    BETTER_AUTH_SECRET: secret(),
    OAUTH_PROXY_SECRET: secret(),
    WELDALL_SIGNING_PRIVATE_JWK: JSON.stringify(weldall.privateJwk),
    WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(weldall.publicJwk),
    WELDALL_SIGNING_KID: "weldall-e2e",
    WELDALL_DEPLOYMENT_MODE: "e2e",
    ENABLE_DEV_LOGIN: "true",
    DEV_IDP_ISSUER: "https://dev-idp.seibert.localdev",
    DEV_IDP_CLIENT_ID: "weldall-dev",
    DEV_IDP_CLIENT_SECRET: devIdpClientSecret,
  },
  "expenses/env.sh": {
    EXPENSES_SIGNING_PRIVATE_JWK: JSON.stringify(expenses.privateJwk),
    EXPENSES_SIGNING_PUBLIC_JWK: JSON.stringify(expenses.publicJwk),
    EXPENSES_SIGNING_KID: "expenses-e2e",
    WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(weldall.publicJwk),
    WELDALL_SIGNING_KID: "weldall-e2e",
  },
  "dev-idp/env.sh": {
    DEV_IDP_ISSUER: "https://dev-idp.seibert.localdev",
    DEV_IDP_CLIENT_ID: "weldall-dev",
    DEV_IDP_CLIENT_SECRET: devIdpClientSecret,
    DEV_IDP_REDIRECT_URI: "http://localhost:3000/api/auth/callback/dev-oidc",
    DEV_IDP_SIGNING_PRIVATE_JWK: JSON.stringify(devIdp.privateJwk),
    DEV_IDP_SIGNING_PUBLIC_JWK: JSON.stringify(devIdp.publicJwk),
    DEV_IDP_SIGNING_KID: "dev-idp-e2e",
    DEV_IDP_USERS_JSON: devUsers,
  },
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  Object.entries(files).map(async ([name, values]) => {
    const output = join(outputDirectory, name);
    const temporary = `${output}.tmp`;
    await mkdir(dirname(output), { recursive: true });
    const content = `${Object.entries(values)
      .map(([key, value]) => `export ${key}=${quote(value)}`)
      .join("\n")}\n`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, output);
    await chmod(output, 0o600);
  }),
);
