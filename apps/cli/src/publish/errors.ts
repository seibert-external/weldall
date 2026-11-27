import { CliError } from "../errors.js";

/**
 * A publish or sync that stopped. `code` is stable for agents (`--json` prints it); the message
 * says what happened and what to do next. Unless the code says otherwise, nothing was published.
 */
export class PublishError extends CliError {
  /** Fixed facts about the stop for agents; `--json` prints them as `error.details`. */
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(
    readonly code: string,
    message: string,
    options: {
      cause?: unknown;
      hint?: string;
      exitCode?: number;
      details?: Record<string, string>;
    } = {},
  ) {
    const { details, ...rest } = options;
    super(message, rest);
    this.name = "PublishError";
    this.details = details;
  }
}
