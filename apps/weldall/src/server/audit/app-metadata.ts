import { z } from "zod";
import { boundedGitText, GIT_AUDIT_LIMITS } from "./git-metadata";

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,191}$/);
const repositoryPart = z.preprocess(
  (value) =>
    typeof value === "string" ? boundedGitText(value, GIT_AUDIT_LIMITS.repositoryPart) : value,
  z.string().min(1).max(GIT_AUDIT_LIMITS.repositoryPart),
);
const appState = z.enum(["active", "expiring_soon", "expired"]);

/**
 * The owner confirmed that an app is still needed (INV-183): the expiry moved from
 * `previousExpiresAt` to `expiresAt`. `previousState` shows whether the app was flagged.
 */
const confirmationSucceeded = z
  .object({
    appId: id,
    connectorId: id,
    repositoryOwner: repositoryPart,
    repositoryName: repositoryPart,
    previousExpiresAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    previousState: appState,
  })
  .strict();
/**
 * A confirmation was refused. An unknown id and another person's app are refused alike, so the
 * entry records only the requested id (null when it was not a well-formed id) and the reason.
 */
const confirmationDenied = z
  .object({
    appId: id.nullable(),
    reason: z.string().min(1).max(500),
  })
  .strict();

export const appMetadataSchemas = {
  "app_confirmation.succeeded": confirmationSucceeded,
  "app_confirmation.denied": confirmationDenied,
} as const;
