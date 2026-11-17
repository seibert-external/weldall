import { CliError } from "../errors.js";

/**
 * A publish or sync that stopped. `code` is stable for agents (`--json` prints it); the message
 * says what happened and what to do next. Unless the code says otherwise, nothing was published.
 */
export class PublishError extends CliError {
  constructor(
    readonly code: string,
    message: string,
    options: { cause?: unknown; hint?: string; exitCode?: number } = {},
  ) {
    super(message, options);
    this.name = "PublishError";
  }
}
