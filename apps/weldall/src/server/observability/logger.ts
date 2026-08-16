import { AsyncLocalStorage } from "node:async_hooks";
import { Logger, type ISettingsParam } from "tslog";

export interface LogContext extends Record<string, unknown> {
  requestId?: string;
  correlationId?: string;
  method?: string;
  route?: string;
}

type LogRecord = Record<string, unknown>;
type LogLevelName = "SILLY" | "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

const LOG_LEVELS = new Set<LogLevelName>([
  "SILLY",
  "TRACE",
  "DEBUG",
  "INFO",
  "WARN",
  "ERROR",
  "FATAL",
]);
const sensitiveValuePatterns = [
  /\b(?:Bearer|DPoP|Token)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:https?|postgres(?:ql)?):\/\/[^:\s/@]+:[^@\s/]+@/gi,
];

export function resolveLogLevel(value = process.env.LOG_LEVEL): LogLevelName {
  const normalized = value?.trim().toUpperCase() ?? "INFO";
  if (!LOG_LEVELS.has(normalized as LogLevelName)) {
    throw new Error(`Invalid LOG_LEVEL ${JSON.stringify(value)}`);
  }
  return normalized as LogLevelName;
}

export function createAppLogger(overrides: ISettingsParam<LogRecord> = {}): Logger<LogRecord> {
  return new Logger<LogRecord>({
    name: "weldall",
    type:
      process.env.NODE_ENV === "production"
        ? "json"
        : process.env.NODE_ENV === "test"
          ? "hidden"
          : "pretty",
    minLevel: resolveLogLevel(),
    bindings: {
      service: "weldall",
      environment: process.env.NODE_ENV ?? "development",
    },
    json: { stableKeyOrder: true },
    mask: {
      keys: [
        "authorization",
        "actorEmail",
        "client_assertion",
        "clientSecret",
        "cookie",
        "dpop",
        "email",
        "encryptedToken",
        "googleClientSecret",
        "normalizedEmail",
        "password",
        "private_jwk",
        "privateJwk",
        "privateKey",
        "refresh_token",
        "secret",
        "set-cookie",
        "subject_token",
        "token",
        "access_token",
      ],
      caseInsensitive: true,
      regex: sensitiveValuePatterns,
    },
    stack: { capture: process.env.NODE_ENV === "production" ? "off" : "auto" },
    contextStorage: new AsyncLocalStorage<LogContext>(),
    strictConfig: true,
    ...overrides,
  });
}

export const logger = createAppLogger();

export function errorForLog(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      name: "NonErrorThrown",
      value:
        typeof error === "string" || typeof error === "number" || typeof error === "boolean"
          ? redactSensitiveValues(String(error))
          : Object.prototype.toString.call(error),
    };
  }
  const code = (error as Error & { code?: unknown }).code;
  return {
    name: error.name,
    message: redactSensitiveValues(error.message),
    ...(error.stack ? { stack: redactSensitiveValues(error.stack) } : {}),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(error.cause !== undefined && depth < 3
      ? { cause: errorForLog(error.cause, depth + 1) }
      : {}),
  };
}

function redactSensitiveValues(value: string): string {
  return sensitiveValuePatterns.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[***]"),
    value,
  );
}
