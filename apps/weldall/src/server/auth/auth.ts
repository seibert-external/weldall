import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { db } from "@weldall/db";
import { WELDALL_CLIENT_ID, WELDALL_ISSUER, WELDALL_RESOURCE } from "../oauth/constants";
import { signWeldallJwt } from "../oauth/jwt";
import { requireLoginScopeForOAuthGrant } from "./login-policy";
import { errorForLog, logger } from "../observability/logger";
import { oidcLoginPlugin } from "./oidc-plugin";
const required = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is required`);
  return v;
};
const signingKid = required("WELDALL_SIGNING_KID");
const cliScopes = ["openid", "profile", "email", "offline_access", "weldall:scopes"];
const authLogger = logger.child({ name: "better-auth" });

export const auth = betterAuth({
  baseURL: WELDALL_ISSUER,
  basePath: "/api/auth",
  secret: required("BETTER_AUTH_SECRET"),
  database: prismaAdapter(db, { provider: "postgresql" }),
  trustedOrigins: [WELDALL_ISSUER],
  account: { accountLinking: { enabled: false } },
  disabledPaths: [
    "/sign-in/social",
    "/sign-in/email",
    "/sign-up/email",
    "/link-social",
    "/unlink-account",
    "/change-email",
    "/set-password",
    "/change-password",
    "/request-password-reset",
    "/reset-password",
    "/send-verification-email",
    "/verify-email",
    "/get-access-token",
    "/refresh-token",
  ],
  logger: {
    level: "debug",
    log(level, message, ...args) {
      const error = args.find((value): value is Error => value instanceof Error);
      const fields = {
        event: "better-auth.log",
        ...(error ? { error: errorForLog(error) } : {}),
      };
      if (level === "error") authLogger.error(fields, message);
      else if (level === "warn") authLogger.warn(fields, message);
      else if (level === "info") authLogger.info(fields, message);
      else authLogger.debug(fields, message);
    },
  },
  rateLimit: {
    customRules: { "/oauth2/token": false },
  },
  socialProviders: {},
  plugins: [
    oidcLoginPlugin(),
    jwt({
      jwks: {
        remoteUrl: `${WELDALL_ISSUER}/api/oauth/jwks`,
        keyPairConfig: { alg: "ES256" },
      },
      jwt: {
        issuer: WELDALL_ISSUER,
        audience: WELDALL_RESOURCE,
        sign: signWeldallJwt,
      },
    }),
    oauthProvider({
      loginPage: "/login",
      silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
      consentPage: "/consent",
      scopes: cliScopes,
      customTokenResponseFields: requireLoginScopeForOAuthGrant,
      dpop: { proofMaxAgeSeconds: 60, signingAlgorithms: ["ES256"] },
      cachedTrustedClients: new Set([WELDALL_CLIENT_ID]),
      enforcePerClientResources: false,
      resourceSeedMode: "overwrite",
      resources:
        process.env.WELDALL_SKIP_RESOURCE_SEED === "true"
          ? []
          : [
              {
                identifier: WELDALL_RESOURCE,
                name: "Weldall API",
                allowedScopes: cliScopes,
                dpopBoundAccessTokensRequired: true,
                signingAlgorithm: "ES256",
                signingKeyId: signingKid,
              },
            ],
    }) as any,
  ],
});
