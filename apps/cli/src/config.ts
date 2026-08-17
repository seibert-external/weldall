import { createInterface } from "node:readline/promises";
import { ConfigurationError, errorMessage } from "./errors.js";
import { issuerPreferences, type IssuerPreferences } from "./storage/preferences.js";

const REQUIRED_SCOPES = ["openid", "profile", "email", "offline_access", "weldall:scopes"] as const;

export type IssuerSource = "environment" | "preferences" | "prompt";

export interface BrowserConnectionEndpoints {
  deviceAuthorization: string;
  pendingLookup: string;
  pendingDecision: string;
}

export interface WeldallConfig {
  issuer: string;
  resource: string;
  authorize: string;
  token: string;
  revoke: string;
  jwks: string;
  cli: string;
  grants: string;
  scopes: string;
  skills: string;
  userInfo: string;
  browserConnections?: BrowserConnectionEndpoints;
}

export interface IssuerSelection {
  issuer: string;
  source: IssuerSource;
}

type Metadata = Record<string, unknown>;
type PromptIssuer = () => Promise<string>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;

export function normalizeIssuer(input: string): string {
  const candidate = input.trim();
  if (!candidate)
    throw new ConfigurationError("The Weldall issuer is empty", {
      hint: "Use a URL such as https://weldall.example.com.",
    });
  let url: URL;
  try {
    url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
  } catch (error) {
    throw new ConfigurationError(`Invalid Weldall issuer: ${candidate}`, { cause: error });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new ConfigurationError("The Weldall issuer must be an HTTPS origin without a path", {
      hint: "Example: https://weldall.example.com",
    });
  return url.origin;
}

const metadataUrl = (issuer: string, path: string) => new URL(path, `${issuer}/`).toString();

const requiredEndpoint = (
  metadata: Metadata,
  key: string,
  issuer: string,
  expectedPath: string,
): string => {
  const value = metadata[key];
  if (typeof value !== "string") throw new ConfigurationError(`Weldall metadata has no ${key}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ConfigurationError(`Weldall metadata contains an invalid ${key}`, { cause: error });
  }
  if (
    url.origin !== issuer ||
    url.protocol !== "https:" ||
    url.pathname !== expectedPath ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new ConfigurationError(`Weldall metadata contains an unexpected ${key}`);
  return url.toString();
};

async function fetchMetadata(
  url: string,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<Metadata> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ConfigurationError(`Unable to reach ${new URL(url).origin}`, {
      cause: error,
      hint: errorMessage(error),
    });
  }
  if (!response.ok)
    throw new ConfigurationError(`Weldall discovery failed with HTTP ${response.status}`);
  const value = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(value)) throw new ConfigurationError("Weldall discovery returned invalid JSON");
  return value;
}

export async function discoverIssuer(
  rawIssuer: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<WeldallConfig> {
  const issuer = normalizeIssuer(rawIssuer);
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const metadata = await fetchMetadata(
    metadataUrl(issuer, "/.well-known/oauth-authorization-server"),
    fetcher,
    timeoutMs,
  );
  if (metadata.issuer !== issuer)
    throw new ConfigurationError("Weldall discovery returned a different issuer");

  const scopes = stringArray(metadata.scopes_supported);
  if (!scopes || REQUIRED_SCOPES.some((scope) => !scopes.includes(scope)))
    throw new ConfigurationError("Weldall does not advertise the required OAuth scopes");
  const grants = stringArray(metadata.grant_types_supported);
  if (!grants?.includes("authorization_code") || !grants.includes("refresh_token"))
    throw new ConfigurationError("Weldall does not support CLI login and token refresh");
  if (!stringArray(metadata.code_challenge_methods_supported)?.includes("S256"))
    throw new ConfigurationError("Weldall does not support PKCE S256");
  if (!stringArray(metadata.dpop_signing_alg_values_supported)?.includes("ES256"))
    throw new ConfigurationError("Weldall does not support ES256 DPoP proofs");
  if (metadata.authorization_response_iss_parameter_supported !== true)
    throw new ConfigurationError("Weldall does not bind authorization responses to its issuer");

  let browserConnections: BrowserConnectionEndpoints | undefined;
  const browserProfile = metadata.weldall_browser_connections;
  const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
  if (browserProfile !== undefined || metadata.device_authorization_endpoint !== undefined) {
    if (!isRecord(browserProfile))
      throw new ConfigurationError("Weldall browser-connection metadata is invalid");
    const extensions = stringArray(browserProfile.profile_extensions);
    if (
      browserProfile.approval_profile !== "cli-code" ||
      !extensions?.includes("cli-approval") ||
      !extensions.includes("initiation-time-dpop-binding") ||
      !grants.includes(deviceGrant)
    )
      throw new ConfigurationError("Weldall browser-connection profile is incomplete");
    browserConnections = {
      deviceAuthorization: requiredEndpoint(
        metadata,
        "device_authorization_endpoint",
        issuer,
        "/api/auth/oauth2/device_authorization",
      ),
      pendingLookup: requiredEndpoint(
        browserProfile,
        "pending_lookup_endpoint",
        issuer,
        "/api/me/browser-connections/pending/lookup",
      ),
      pendingDecision: requiredEndpoint(
        browserProfile,
        "pending_decision_endpoint",
        issuer,
        "/api/me/browser-connections/pending/decision",
      ),
    };
  }

  const resource = `${issuer}/api`;
  const protectedResource = await fetchMetadata(
    metadataUrl(issuer, "/.well-known/oauth-protected-resource/api"),
    fetcher,
    timeoutMs,
  );
  if (
    protectedResource.resource !== resource ||
    !stringArray(protectedResource.authorization_servers)?.includes(issuer)
  )
    throw new ConfigurationError("Weldall protected-resource metadata is inconsistent");

  return {
    issuer,
    resource,
    authorize: requiredEndpoint(
      metadata,
      "authorization_endpoint",
      issuer,
      "/api/auth/oauth2/authorize",
    ),
    token: requiredEndpoint(metadata, "token_endpoint", issuer, "/api/auth/oauth2/token"),
    revoke: requiredEndpoint(metadata, "revocation_endpoint", issuer, "/api/auth/oauth2/revoke"),
    jwks: requiredEndpoint(metadata, "jwks_uri", issuer, "/api/oauth/jwks"),
    cli: `${issuer}/api/me/cli`,
    grants: `${issuer}/api/me/grants`,
    scopes: `${issuer}/api/me/scopes`,
    skills: `${issuer}/api/me/skills`,
    userInfo: `${issuer}/api/auth/oauth2/userinfo`,
    ...(browserConnections ? { browserConnections } : {}),
  };
}

export async function promptForIssuer(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new ConfigurationError("No Weldall issuer is configured", {
      hint: "Set WELDALL_ISSUER or run `weldall config set-issuer <https://host>`.",
    });
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question(
      [
        "Weldall CLI needs to know which Weldall server to connect to.",
        "Enter your organization's base HTTPS address without a path.",
        "Example: https://weldall.example.com",
        "Ask your Weldall administrator if you do not know the address.",
        "Weldall host: ",
      ].join("\n"),
    );
  } finally {
    prompt.close();
  }
}

export async function selectIssuer(
  options: {
    environmentValue?: string;
    preferences?: IssuerPreferences;
    prompt?: PromptIssuer;
    allowPrompt?: boolean;
  } = {},
): Promise<IssuerSelection | null> {
  const environmentValue =
    options.environmentValue === undefined ? process.env.WELDALL_ISSUER : options.environmentValue;
  if (environmentValue !== undefined)
    return { issuer: normalizeIssuer(environmentValue), source: "environment" };

  const preferences = options.preferences ?? issuerPreferences;
  const stored = await preferences.read();
  if (stored) return { issuer: normalizeIssuer(stored), source: "preferences" };
  if (options.allowPrompt === false) return null;

  const issuer = normalizeIssuer(await (options.prompt ?? promptForIssuer)());
  return { issuer, source: "prompt" };
}

export async function resolveWeldallConfig(
  options: {
    environmentValue?: string;
    preferences?: IssuerPreferences;
    prompt?: PromptIssuer;
    fetcher?: typeof fetch;
  } = {},
): Promise<WeldallConfig> {
  const preferences = options.preferences ?? issuerPreferences;
  const selection = await selectIssuer({
    ...(options.environmentValue === undefined
      ? {}
      : { environmentValue: options.environmentValue }),
    preferences,
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
  });
  if (!selection) throw new ConfigurationError("No Weldall issuer is configured");
  const config = await discoverIssuer(selection.issuer, {
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  if (selection.source === "prompt") await preferences.write(config.issuer);
  return config;
}
