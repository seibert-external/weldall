export type GoogleApi = "gmail" | "calendar";

export interface ConnectorDefinition {
  type: "google";
  name: string;
  configurationVersion: "1";
  availableApis: readonly GoogleApi[];
}

export interface GoogleConnectorConfig {
  clientId: string;
  clientSecret: string;
  enabledApis: GoogleApi[];
  oauthScopes: string[];
}

export class ConnectorAuthorizationError extends Error {
  constructor(
    message: string,
    readonly reconnectRequired: boolean,
  ) {
    super(message);
    this.name = "ConnectorAuthorizationError";
  }
}

/** Provider token format, independent of where the caller stores it. */
export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  grantedScopes: string[];
  tokenType: "Bearer";
}

export interface AuthorizationResult {
  account: { id: string; displayName: string };
  credentials: OAuthCredentials;
}

export interface ConnectorImplementation<TConfig> {
  readonly definition: ConnectorDefinition;
  validateConfig(value: unknown): Promise<TConfig>;
  startAuthorization(input: {
    config: TConfig;
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<{ url: string }>;
  completeAuthorization(input: {
    config: TConfig;
    redirectUri: string;
    code: string;
    nonce: string;
    codeVerifier: string;
  }): Promise<AuthorizationResult>;
  refreshCredentials(input: {
    config: TConfig;
    refreshToken: string;
    grantedScopes: string[];
  }): Promise<OAuthCredentials>;
  revokeCredentials(input: { config: TConfig; token: string }): Promise<void>;
}
