/** Safe, fixed-message domain errors; provider payloads must never be attached as causes. */
export class ConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Retains rejected credentials only for encrypted cleanup, never for logging or execution. */
export class RejectedProviderCredentials extends ConnectorError {
  readonly credentials!: object;
  constructor({ credentials }: { credentials: object }) {
    super("grant_mismatch", "Provider grant differs from the request.");
    Object.defineProperty(this, "credentials", { value: credentials, enumerable: false });
  }
}

/** Distinguishes explicit transient token failures from uncertain refresh outcomes. */
export class ProviderTokenError extends ConnectorError {
  readonly authorizationLost: boolean;
  readonly retryable: boolean;
  constructor({
    authorizationLost,
    retryable = false,
  }: {
    authorizationLost: boolean;
    retryable?: boolean;
  }) {
    super(
      authorizationLost ? "authorization_lost" : "provider_unavailable",
      "Provider token request failed; reconnect if recovery is uncertain.",
      502,
    );
    this.authorizationLost = authorizationLost;
    this.retryable = retryable;
  }
}
