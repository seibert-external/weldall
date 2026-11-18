import { redactCredentials, redactCredentialsDeep } from "./redaction.js";

export type LogLevel = "info" | "warn" | "error";
export type Logger = (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;

/**
 * One JSON line per entry on stderr. Every string is passed through credential redaction, so a
 * host token or key that slipped into an error never reaches the log; callers still log only
 * codes, ids and repository names, never secrets or host response bodies.
 */
export const jsonLogger: Logger = (level, message, fields = {}) => {
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level,
      message: redactCredentials(message),
      ...(redactCredentialsDeep(fields) as Record<string, unknown>),
    })}\n`,
  );
};

/** What may be logged of an unknown error: its name and code, never its message or cause. */
export function errorForLog(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { errorType: typeof error };
  const code = (error as { code?: unknown }).code;
  return { errorName: error.name, ...(typeof code === "string" ? { errorCode: code } : {}) };
}
