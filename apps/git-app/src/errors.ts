/**
 * Safe, fixed-message domain errors of the Git app (carried over from the server's
 * `ConnectorError`). Messages are written by the Git app from validated configuration and parsed
 * host fields, never copied from a host response, and never contain a credential. Host payloads
 * must never be attached as causes.
 */
export class GitAppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
