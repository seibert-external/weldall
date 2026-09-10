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
const [weldall, expenses, devIdp, machine] = await Promise.all([
  generateEs256KeyPair(),
  generateEs256KeyPair(),
  generateEs256KeyPair(),
  generateEs256KeyPair(),
]);
const secret = () => randomBytes(32).toString("base64url");
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const postgresUrl = "postgresql://postgres:postgres@postgres:5432/postgres";
const setupToken = secret();
const devIdpClientSecret = secret();
const credentialEncryptionKey = randomBytes(32).toString("base64");
const devUsers = JSON.stringify([
  {
    sub: "dev-alice",
    email: "alice@example.com",
    name: "Alice E2E",
    emailVerified: true,
  },
  {
    sub: "dev-bob",
    email: "bob@example.com",
    name: "Bob E2E",
    emailVerified: true,
  },
]);

// apps/e2e/test/system.spec.ts logs in as alice (administrator path) and as bob
// (login-denied path) by selecting these addresses on the development IdP form.
// Generating an identity set without them would only show up later as a failing
// selectOption, so reject it here, before any container starts.
const requiredDevEmails = ["alice@example.com", "bob@example.com"];
const generatedDevEmails = new Set(
  (JSON.parse(devUsers) as { email: string }[]).map((user) => user.email.toLowerCase()),
);
const missingDevEmails = requiredDevEmails.filter((email) => !generatedDevEmails.has(email));
if (missingDevEmails.length > 0) {
  throw new Error(
    `E2E development IdP is missing required identities: ${missingDevEmails.join(", ")}. ` +
      "Add them to devUsers in scripts/generate-e2e-env.ts.",
  );
}

const files: Record<string, Record<string, string>> = {
  "database/env.sh": {
    POSTGRES_URL: postgresUrl,
    WELDALL_DEPLOYMENT_MODE: "e2e",
    WELDALL_SETUP_TOKEN: setupToken,
    WELDALL_CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey,
    DEV_IDP_CLIENT_ID: "weldall-dev",
    DEV_IDP_CLIENT_SECRET: devIdpClientSecret,
    DEV_M2M_SIGNING_PUBLIC_JWK: JSON.stringify(machine.publicJwk),
    DEV_M2M_SIGNING_KID: "dev-m2m-e2e",
  },
  "weldall/env.sh": {
    POSTGRES_URL: postgresUrl,
    BETTER_AUTH_SECRET: secret(),
    WELDALL_SETUP_TOKEN: setupToken,
    WELDALL_CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey,
    WELDALL_SIGNING_PRIVATE_JWK: JSON.stringify(weldall.privateJwk),
    WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(weldall.publicJwk),
    WELDALL_SIGNING_KID: "weldall-e2e",
    WELDALL_DEPLOYMENT_MODE: "e2e",
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
    WELDALL_ISSUER: "https://weldall.seibert.localdev",
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
