import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { isRecord } from "../http.js";
import { authenticatedGet } from "./skills.js";

/**
 * Apps the signed-in person may see: their own, and those shared with a permission they hold.
 * Served by `GET /api/me/apps`; a server that predates app discovery answers 404.
 */
export interface AppSummary {
  id: string;
  sourceId: string;
  name: string;
  description: string;
  own: boolean;
  /** False when the registry reports no owner for the app. */
  hasOwner: boolean;
  ownerName: string | null;
  scopes: string[];
  /** Null for an app without a Git repository. */
  repository: { name: string; url: string } | null;
  /** Where the app runs; null when it has no link. */
  url: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  expired: boolean;
  source: { type: string; key: string; name: string };
}
export interface AppWarning {
  source: string;
  code: string;
}
export interface AppList {
  items: AppSummary[];
  warnings: AppWarning[];
}

const isRepository = (value: unknown) =>
  value === null ||
  (isRecord(value) && typeof value.name === "string" && typeof value.url === "string");

const isAppSummary = (value: unknown): value is AppSummary =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.sourceId === "string" &&
  typeof value.name === "string" &&
  typeof value.description === "string" &&
  typeof value.own === "boolean" &&
  typeof value.hasOwner === "boolean" &&
  (value.ownerName === null || typeof value.ownerName === "string") &&
  Array.isArray(value.scopes) &&
  value.scopes.every((scope) => typeof scope === "string") &&
  isRepository(value.repository) &&
  (value.url === null || typeof value.url === "string") &&
  typeof value.revision === "number" &&
  typeof value.createdAt === "string" &&
  typeof value.updatedAt === "string" &&
  typeof value.expiresAt === "string" &&
  typeof value.expired === "boolean" &&
  isRecord(value.source) &&
  typeof value.source.type === "string" &&
  typeof value.source.key === "string" &&
  typeof value.source.name === "string";

export function parseAppList(value: unknown): AppList {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !value.items.every(isAppSummary) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every(
      (warning) =>
        isRecord(warning) && typeof warning.source === "string" && typeof warning.code === "string",
    )
  )
    throw new CliError("Weldall returned an invalid app list");
  return value as unknown as AppList;
}

const APP_LIST_LABEL = "Weldall app list request";

export async function listApps(config: WeldallConfig): Promise<AppList> {
  try {
    const { value } = await authenticatedGet(
      config,
      `${config.issuer}/api/me/apps`,
      undefined,
      APP_LIST_LABEL,
    );
    return parseAppList(value);
  } catch (error) {
    // The transfer layer carries the status only in the message, so match its exact prefix rather
    // than any "HTTP 404" that a server's error detail might contain.
    const notFound = `${APP_LIST_LABEL} failed with HTTP 404`;
    if (
      error instanceof CliError &&
      (error.message === notFound || error.message.startsWith(`${notFound}:`))
    )
      throw new CliError("This Weldall server does not offer apps.", {
        cause: error,
        hint: "App discovery needs a newer Weldall server.",
      });
    throw error;
  }
}
