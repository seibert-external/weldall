import { db, type App, type Prisma } from "@weldall/db";
import { prismaAuditWriter } from "../audit/service";
import { ConnectorError, type ConnectorActor } from "../connectors/contracts";
import { safeHttpsUrl } from "../connectors/git-text";
import { deriveWebBaseUrl, githubAppConfigSchema } from "../connectors/providers/github-app/config";
import { APP_REVERIFICATION_DAYS } from "./service";
import { APP_EXPIRING_SOON_DAYS, appState, appStateWhere, type AppState } from "./state";

/**
 * Reads of the app registry for the three audiences of INV-183 (the owner, administrators, and
 * the customer's own tools through a machine client) and the owner's confirmation. The state is
 * derived from the expiry on every read; nothing here stops or blocks an expired app.
 */

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const appIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

/** What every audience sees of one app. Dates are ISO 8601 in UTC; links are https or null. */
export interface AppRegistryEntry {
  id: string;
  name: string;
  purpose: string;
  repository: {
    /** Key of the Git host connector the repository lives on. */
    connector: string;
    owner: string;
    name: string;
    /** Browser link to the repository on the Git host; null when the host is not known. */
    webUrl: string | null;
  };
  /** Template the app started from; null for a registered existing repository. */
  template: string | null;
  links: { preview: string | null; live: string | null };
  createdAt: string;
  /** Null until the owner confirmed the app for the first time. */
  confirmedAt: string | null;
  expiresAt: string;
  state: AppState;
}
/** The registry's rules, returned with each list so clients need not hard-code them. */
export const APP_REGISTRY_POLICY = {
  reverificationDays: APP_REVERIFICATION_DAYS,
  expiringSoonDays: APP_EXPIRING_SOON_DAYS,
} as const;

const connectorSelect = { select: { key: true, providerType: true, providerConfig: true } };
type RegistryRow = App & {
  connector: { key: string; providerType: string; providerConfig: Prisma.JsonValue };
};

/** Browser link of a repository, from the connector's configuration only (no host call). */
function repositoryWebUrl(row: RegistryRow): string | null {
  if (row.connector.providerType !== "github-app") return null;
  const config = githubAppConfigSchema.safeParse(row.connector.providerConfig);
  const base = config.success ? deriveWebBaseUrl(config.data.apiBaseUrl) : null;
  return base
    ? `${base}/${encodeURIComponent(row.repositoryOwner)}/${encodeURIComponent(row.repositoryName)}`
    : null;
}

export function presentApp(row: RegistryRow, now: Date): AppRegistryEntry {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    repository: {
      connector: row.connector.key,
      owner: row.repositoryOwner,
      name: row.repositoryName,
      webUrl: repositoryWebUrl(row),
    },
    template: row.template,
    links: { preview: safeHttpsUrl(row.previewUrl), live: safeHttpsUrl(row.liveUrl) },
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    state: appState(row.expiresAt, now),
  };
}

/** Owner first: the apps one person owns, expired and expiring ones first. */
export async function listOwnApps(actor: ConnectorActor) {
  assertPerson(actor);
  const now = new Date();
  const rows = await db.app.findMany({
    where: { ownerId: actor.id },
    include: { connector: connectorSelect },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
  });
  return { apps: rows.map((row) => presentApp(row, now)), ...APP_REGISTRY_POLICY };
}

function assertPerson(actor: ConnectorActor) {
  if (actor.type === "machine")
    throw new ConnectorError(
      "connection_denied",
      "Apps are owned by people; sign in as a user.",
      403,
    );
}

/**
 * The owner confirms that the app is still needed: the expiry moves to now plus
 * {@link APP_REVERIFICATION_DAYS}, and when and by whom is recorded. Only the owner may confirm;
 * an unknown id and another person's app get the same 404. Confirmation and its audit entry
 * commit together. Publishing never does this implicitly.
 */
export async function confirmApp({
  actor,
  appId,
}: {
  actor: ConnectorActor;
  appId: string;
}): Promise<{ app: AppRegistryEntry }> {
  assertPerson(actor);
  const known = appIdPattern.test(appId);
  const confirmed = known
    ? await db.$transaction(async (tx) => {
        const app = await tx.app.findUnique({ where: { id: appId } });
        if (!app || app.ownerId !== actor.id) return null;
        const now = new Date();
        const updated = await tx.app.update({
          where: { id: app.id },
          data: {
            expiresAt: new Date(now.getTime() + APP_REVERIFICATION_DAYS * DAY_IN_MS),
            confirmedAt: now,
            confirmedBy: actor.id,
          },
          include: { connector: connectorSelect },
        });
        await writeConfirmationAudit(actor, tx, {
          outcome: "success",
          metadata: {
            appId: app.id,
            connectorId: app.connectorId,
            repositoryOwner: app.repositoryOwner,
            repositoryName: app.repositoryName,
            previousExpiresAt: app.expiresAt.toISOString(),
            expiresAt: updated.expiresAt.toISOString(),
            previousState: appState(app.expiresAt, now),
          },
        });
        return presentApp(updated, now);
      })
    : null;
  if (confirmed) return { app: confirmed };
  const message = "No app of yours has this id.";
  await writeConfirmationAudit(actor, undefined, {
    outcome: "denied",
    metadata: { appId: known ? appId : null, reason: message },
  });
  throw new ConnectorError("not_found", message, 404);
}

function writeConfirmationAudit(
  actor: ConnectorActor,
  tx: Prisma.TransactionClient | undefined,
  input:
    | { outcome: "success"; metadata: { appId: string } & Record<string, unknown> }
    | { outcome: "denied"; metadata: { appId: string | null; reason: string } },
) {
  return prismaAuditWriter.write(
    {
      eventType:
        input.outcome === "success" ? "app_confirmation.succeeded" : "app_confirmation.denied",
      actorType: actor.type ?? "user",
      actorId: actor.id,
      ...(actor.email ? { actorEmail: actor.email } : {}),
      requestId: actor.requestId,
      ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
      outcome: input.outcome,
      ...(input.outcome === "success"
        ? { subjectType: "app", subjectId: input.metadata.appId }
        : { reasonCode: "invalid_request" as const }),
      metadata: input.metadata,
    },
    tx,
  );
}

/** Administrators: one app with its owner. */
export interface AdminAppEntry extends AppRegistryEntry {
  owner: { id: string; name: string; email: string };
}

/**
 * Every app for the admin list, expired and expiring ones first (ascending expiry is exactly that
 * order, since the state follows the expiry). `q` searches name, purpose, repository and owner.
 */
export async function listAppsForAdmin(input: {
  page: number;
  pageSize: number;
  q?: string | undefined;
  state?: AppState | undefined;
}): Promise<{ items: AdminAppEntry[]; total: number } & typeof APP_REGISTRY_POLICY> {
  const now = new Date();
  const q = input.q?.trim();
  const where: Prisma.AppWhereInput = {
    AND: [
      input.state ? appStateWhere(input.state, now) : {},
      q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { purpose: { contains: q, mode: "insensitive" } },
              { repositoryOwner: { contains: q, mode: "insensitive" } },
              { repositoryName: { contains: q, mode: "insensitive" } },
              { owner: { email: { contains: q, mode: "insensitive" } } },
              { owner: { name: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {},
    ],
  };
  const [rows, total] = await Promise.all([
    db.app.findMany({
      where,
      include: {
        connector: connectorSelect,
        owner: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    }),
    db.app.count({ where }),
  ]);
  return {
    items: rows.map((row) => ({ ...presentApp(row, now), owner: row.owner })),
    total,
    ...APP_REGISTRY_POLICY,
  };
}

/**
 * The customer's own tools: the owner as Weldall user id and email address. The email lets IT
 * reach the person and match them in its directory; the id stays stable when the address
 * changes. The display name is left out (data minimisation): the directory has it.
 */
export interface MachineAppEntry extends AppRegistryEntry {
  owner: { id: string; email: string };
}

export const MACHINE_APP_PAGE_SIZE = { default: 100, maximum: 200 } as const;

/** Thrown for a cursor the server did not issue. */
export class InvalidAppCursorError extends Error {}

const encodeCursor = (row: { createdAt: Date; id: string }) =>
  Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString("base64url");
function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string" &&
      appIdPattern.test(value[1])
    ) {
      const createdAt = new Date(value[0]);
      if (!Number.isNaN(createdAt.getTime()) && createdAt.toISOString() === value[0])
        return { createdAt, id: value[1] };
    }
  } catch {
    /* Reported below. */
  }
  throw new InvalidAppCursorError("Invalid cursor.");
}

/**
 * One page of the whole registry in creation order (oldest first, then id), so new apps are
 * appended and a client can page through without missing or repeating entries. `nextCursor` is
 * null on the last page.
 */
export async function listAppsForMachine(input: {
  limit: number;
  cursor?: string | undefined;
  state?: AppState | undefined;
}): Promise<
  {
    apps: MachineAppEntry[];
    nextCursor: string | null;
    generatedAt: string;
  } & typeof APP_REGISTRY_POLICY
> {
  const now = new Date();
  const after = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const rows = await db.app.findMany({
    where: {
      AND: [
        input.state ? appStateWhere(input.state, now) : {},
        after
          ? {
              OR: [
                { createdAt: { gt: after.createdAt } },
                { createdAt: after.createdAt, id: { gt: after.id } },
              ],
            }
          : {},
      ],
    },
    include: { connector: connectorSelect, owner: { select: { id: true, email: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: input.limit + 1,
  });
  const page = rows.slice(0, input.limit);
  return {
    apps: page.map((row) => ({ ...presentApp(row, now), owner: row.owner })),
    nextCursor: rows.length > input.limit ? encodeCursor(page.at(-1)!) : null,
    generatedAt: now.toISOString(),
    ...APP_REGISTRY_POLICY,
  };
}
