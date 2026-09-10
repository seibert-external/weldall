import { randomUUID } from "node:crypto";
import { db } from "@weldall/db";
import {
  completeVerifiedAttempt,
  firstProviderId,
  installationCompleted,
} from "../server/auth/login-service";
import { digest } from "../server/auth/oidc-credentials";
import { providerConfigSchema } from "../server/auth/oidc-config";

// Explicit dev seed only. Production startup never imports this file or reads fixture credentials.
if (!["development", "e2e"].includes(process.env.WELDALL_DEPLOYMENT_MODE ?? ""))
  throw new Error("Login fixtures require explicit development/e2e deployment mode.");
try {
  if (!(await installationCompleted())) {
    const config = providerConfigSchema.parse({
      name: "Development fixture",
      buttonLabel: "Development login",
      buttonColor: "#2563eb",
      issuer: "https://dev-idp.seibert.localdev",
      clientId: process.env.DEV_IDP_CLIENT_ID,
      clientSecret: process.env.DEV_IDP_CLIENT_SECRET,
      tokenEndpointAuthMethod: "client_secret_post",
      allowedEmailDomains: ["example.com"],
    });
    const email = "alice@example.com";
    await completeVerifiedAttempt(
      {
        id: randomUUID(),
        state: "dev-seed",
        providerId: await firstProviderId(),
        providerVersion: null,
        mode: "setup",
        encryptedPayload: "",
        payload: {
          config,
          nonce: "dev-seed",
          verifier: "dev-seed",
          adminEmail: email,
          setupTokenHash: digest(process.env.WELDALL_SETUP_TOKEN ?? ""),
          returnTo: "/",
        },
      },
      { issuer: config.issuer, subject: "dev-alice", email, name: "Alice Dev" },
    );
  }
} finally {
  await db.$disconnect();
}
