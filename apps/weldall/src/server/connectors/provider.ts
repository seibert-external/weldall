declare const grantBrand: unique symbol;
declare const upstreamUrlBrand: unique symbol;
export type ProviderGrant<Data extends object = object> = Readonly<Data> & {
  readonly [grantBrand]: true;
};
export type ProviderUpstreamUrl = URL & { readonly [upstreamUrlBrand]: true };
export type ProviderContext = { config: unknown; selection: unknown };
export type ConnectorProxyRequest = {
  requestedUrl: URL;
  method: string;
  headers: Headers;
  body?: Uint8Array;
};

/** Provider-owned values remain opaque to lifecycle and transport code. Each adapter parses boundary input. */
export interface ConnectorProvider {
  readonly type: string;
  /** Parses public policy without accepting secrets. */
  parseConfiguration(value: unknown): object;
  /** Parses write-only application secrets. */
  parseSecrets(value: unknown): object;
  /** Identifies credential binding changes that require removing dependent connections. */
  getConfigurationIdentity(value: unknown): string;
  /** Describes provider-specific setup without exposing stored grants or credentials. */
  describeSetup(input: { config: unknown; previousSelection?: unknown }): object;
  /** Projects provider-owned state into credential-free display metadata. */
  describeConnection(input: { selection: unknown; grant: unknown }): object;
  /** Validates untrusted owner selection against current policy. */
  validateSetupInput(input: { config: unknown; value: unknown }): object;
  /** Creates the initial selection, retaining only still-offered previous choices. */
  buildInitialSelection(input: { config: unknown; previousSelection?: unknown }): object;
  /** Creates provider redirect and opaque attempt data; core binds the returned state to its owner. */
  beginAuthorization(
    input: ProviderContext & { secrets: unknown; callbackUrl: string },
  ): Promise<{ url: string; state: string; attempt: object }>;
  /** Verifies identity and exact consent before returning executable credentials and a branded grant. */
  completeAuthorization(
    input: ProviderContext & {
      secrets: unknown;
      callback: URLSearchParams;
      attempt: unknown;
      callbackUrl: string;
    },
  ): Promise<{ accountId: string; accountName: string; credentials: object; grant: ProviderGrant }>;
  /** Parses decrypted private state before use. */
  parseCredentials(value: unknown): object;
  /** Parses stored grant data; execution also requires reconciliation against selection. */
  parseGrant(value: unknown): ProviderGrant;
  /** Keeps provider expiry semantics outside core. */
  needsRefresh(value: unknown): boolean;
  /** Rotates credentials while enforcing exact consent; rejected credentials may only be retained for cleanup. */
  refreshCredentials(
    input: ProviderContext & {
      secrets: unknown;
      credentials: unknown;
      previousGrant: ProviderGrant;
    },
  ): Promise<{ credentials: object; grant: ProviderGrant }>;
  /** Runs before every dispatch, even when credentials did not need refresh. */
  ensureGrantCurrent(
    input: ProviderContext & { credentials: unknown; previousGrant: ProviderGrant },
  ): Promise<ProviderGrant>;
  /** Reports remote certainty independently of core's local deletion decision. */
  disconnectGrant(input: {
    config: unknown;
    secrets: unknown;
    credentials: unknown;
  }): Promise<{ status: "revoked" | "unsupported" | "unconfirmed"; remediationUrl?: string }>;
  /** Only this boundary may turn untrusted URL metadata into a transport target. */
  resolveUpstreamUrl(
    input: ProviderContext & { requestedUrl: URL; grant: ProviderGrant },
  ): ProviderUpstreamUrl;
  /** Adds provider authorization after core header filtering. */
  buildUpstreamRequest(input: {
    upstreamUrl: ProviderUpstreamUrl;
    credentials: unknown;
    request: ConnectorProxyRequest;
    signal: AbortSignal;
  }): RequestInit;
}
