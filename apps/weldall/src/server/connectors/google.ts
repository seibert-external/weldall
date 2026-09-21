import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type {
  AuthorizationResult,
  ConnectorImplementation,
  GoogleConnectorConfig,
  LocalCredentials,
} from "./types";
import { ConnectorAuthorizationError } from "./types";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const DISCOVERY_ENDPOINT = "https://accounts.google.com/.well-known/openid-configuration";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const API_SCOPES = {
  gmail: [
    "https://www.googleapis.com/auth/gmail.metadata",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://mail.google.com/",
  ],
  calendar: [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar",
  ],
} as const;
const ALL_API_SCOPES = new Set(Object.values(API_SCOPES).flat());

const configSchema = z
  .object({
    clientId: z.string().trim().min(1).max(500),
    clientSecret: z.string().trim().min(1).max(10_000),
    enabledApis: z
      .array(z.enum(["gmail", "calendar"]))
      .min(1)
      .max(2),
    oauthScopes: z.array(z.string()).min(1).max(20),
  })
  .strict()
  .superRefine((config, context) => {
    if (new Set(config.enabledApis).size !== config.enabledApis.length) {
      context.addIssue({ code: "custom", path: ["enabledApis"], message: "APIs must be unique" });
    }
    if (
      new Set(config.oauthScopes).size !== config.oauthScopes.length ||
      config.oauthScopes.some((scope) => !ALL_API_SCOPES.has(scope as never))
    ) {
      context.addIssue({ code: "custom", path: ["oauthScopes"], message: "Invalid Google scope" });
    }
    for (const api of config.enabledApis) {
      if (
        !config.oauthScopes.some((scope) => (API_SCOPES[api] as readonly string[]).includes(scope))
      ) {
        context.addIssue({
          code: "custom",
          path: ["oauthScopes"],
          message: `Select at least one ${api} scope`,
        });
      }
    }
    for (const scope of config.oauthScopes) {
      if (
        !config.enabledApis.some((api) => (API_SCOPES[api] as readonly string[]).includes(scope))
      ) {
        context.addIssue({
          code: "custom",
          path: ["oauthScopes"],
          message: "Scope API is disabled",
        });
      }
    }
  });

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive().max(86_400),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
    token_type: z.string(),
    id_token: z.string().min(1).optional(),
  })
  .passthrough();

async function tokenRequest(body: URLSearchParams) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const value = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new ConnectorAuthorizationError(
      `Google token endpoint returned HTTP ${response.status}`,
      value?.error === "invalid_grant",
    );
  }
  return tokenResponseSchema.parse(await response.json());
}

export async function testGoogleConfiguration(): Promise<void> {
  const response = await fetch(DISCOVERY_ENDPOINT, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Google discovery returned HTTP ${response.status}`);
  const metadata = z
    .object({
      issuer: z.literal("https://accounts.google.com"),
      authorization_endpoint: z.literal(AUTHORIZATION_ENDPOINT),
      token_endpoint: z.literal(TOKEN_ENDPOINT),
      jwks_uri: z.literal("https://www.googleapis.com/oauth2/v3/certs"),
    })
    .passthrough()
    .parse(await response.json());
  void metadata;
}

function localCredentials(
  response: z.infer<typeof tokenResponseSchema>,
  refreshToken: string,
  grantedScopes: string[],
): LocalCredentials {
  if (response.token_type.toLowerCase() !== "bearer") {
    throw new Error("Google returned an unsupported token type");
  }
  return {
    accessToken: response.access_token,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1_000) + response.expires_in,
    grantedScopes,
    tokenType: "Bearer",
  };
}

export const googleConnector: ConnectorImplementation<GoogleConnectorConfig> = {
  definition: {
    type: "google",
    name: "Google",
    configurationVersion: "1",
    credentialModes: ["local"],
    availableApis: ["gmail", "calendar"],
  },

  async validateConfig(value) {
    const parsed = configSchema.parse(value);
    return {
      ...parsed,
      enabledApis: [...new Set(parsed.enabledApis)].sort(),
      oauthScopes: [...new Set(parsed.oauthScopes)].sort(),
    };
  },

  async startAuthorization({ config, redirectUri, state, nonce, codeChallenge }) {
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: ["openid", "email", ...config.oauthScopes].join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString() };
  },

  async completeAuthorization({ config, redirectUri, code, nonce, codeVerifier }) {
    const response = await tokenRequest(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: codeVerifier,
      }),
    );
    if (!response.refresh_token || !response.id_token) {
      throw new Error("Google did not return durable authorization credentials");
    }
    const grantedScopes = [...new Set((response.scope ?? "").split(" ").filter(Boolean))].sort();
    if (config.oauthScopes.some((scope) => !grantedScopes.includes(scope))) {
      throw new Error("Google did not grant every configured scope");
    }
    const verified = await jwtVerify(response.id_token, GOOGLE_JWKS, {
      algorithms: ["RS256"],
      audience: config.clientId,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      requiredClaims: ["iss", "aud", "sub", "exp", "iat", "nonce"],
      maxTokenAge: "10m",
      clockTolerance: 5,
    });
    if (
      verified.payload.nonce !== nonce ||
      typeof verified.payload.sub !== "string" ||
      !verified.payload.sub ||
      (verified.payload.email !== undefined &&
        (typeof verified.payload.email !== "string" ||
          verified.payload.email.length > 320 ||
          verified.payload.email_verified !== true))
    ) {
      throw new Error("Google returned invalid account identity claims");
    }
    return {
      account: {
        id: verified.payload.sub,
        displayName:
          typeof verified.payload.email === "string"
            ? verified.payload.email
            : verified.payload.sub,
      },
      credentials: localCredentials(response, response.refresh_token, grantedScopes),
    } satisfies AuthorizationResult;
  },

  async refreshCredentials({ config, refreshToken, grantedScopes }) {
    const response = await tokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    );
    return localCredentials(response, response.refresh_token ?? refreshToken, grantedScopes);
  },

  async revokeCredentials({ token }) {
    const response = await fetch(REVOCATION_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Google revocation returned HTTP ${response.status}`);
  },
};
