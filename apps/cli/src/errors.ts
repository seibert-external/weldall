export class CliError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(
    message: string,
    options: { cause?: unknown; exitCode?: number; hint?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliError";
    this.exitCode = options.exitCode ?? 1;
    this.hint = options.hint;
  }
}

export class ConfigurationError extends CliError {
  constructor(message: string, options: { cause?: unknown; hint?: string } = {}) {
    super(message, { ...options, exitCode: 2 });
    this.name = "ConfigurationError";
  }
}

export const errorMessage = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "Unexpected command failure";
