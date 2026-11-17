import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "@weldall/db";
import {
  APP_REVERIFICATION_DAYS,
  createApp,
  findAppByRepository,
  listAppsByOwner,
  updateAppLinks,
  type NewApp,
} from "../src/server/app-registry/service";
import {
  deleteConnectorConfiguration,
  runConnectorTransaction,
} from "../src/server/connectors/configuration";
import { ConnectorError } from "../src/server/connectors/errors";

const target = "postgresql://postgres@localhost:5433/postgres";
// Use the operator-approved local database or CI's existing disposable test service; never reset either here.
const approvedTarget =
  process.env.POSTGRES_URL === target ||
  /^postgresql:\/\/postgres@localhost:5433\/weldall_connector_test_[a-f0-9]{32}$/.test(
    process.env.POSTGRES_URL ?? "",
  ) ||
  (process.env.CI === "true" &&
    process.env.POSTGRES_URL === "postgresql://postgres:postgres@localhost:5432/postgres");
const prefix = `appreg-${randomUUID()}`;
const actor = { id: `${prefix}-admin`, requestId: prefix };
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
let connectorId: string;
let otherConnectorId: string;
let n = 0;

const createConnector = (suffix: string) =>
  db.connector.create({
    data: {
      key: `${prefix}-${suffix}`,
      name: "Git host",
      providerType: "google",
      providerConfig: {},
      envelopeProvider: "LOCAL_ENV",
      createdBy: actor.id,
      updatedBy: actor.id,
    },
  });

const app = (overrides: Partial<NewApp> = {}): NewApp => ({
  name: "Expense tracker",
  purpose: "Tracks team expenses",
  ownerId: alice,
  repository: { connectorId, owner: "acme", name: `app-${++n}` },
  defaultBranch: "main",
  ...overrides,
});

const uniqueViolation = { code: "P2002" };

describe.skipIf(!approvedTarget)(
  "app registry on explicitly selected disposable PostgreSQL",
  () => {
    beforeAll(async () => {
      if (!approvedTarget) throw new Error("Unsafe database target");
      for (const id of [alice, bob])
        await db.user.create({
          data: { id, name: id, email: `${id}@example.com`, emailVerified: true },
        });
      connectorId = (await createConnector("github")).id;
      otherConnectorId = (await createConnector("forgejo")).id;
    });

    afterAll(async () => {
      await db.app.deleteMany({ where: { ownerId: { startsWith: prefix } } });
      await db.connector.deleteMany({ where: { key: { startsWith: prefix } } });
      await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
      await db.auditEvent.deleteMany({ where: { actorId: { startsWith: prefix } } });
    });

    it("creates an entry and reads it back by connector and repository", async () => {
      const before = Date.now();
      const created = await createApp(
        app({
          repository: { connectorId, owner: "acme", name: "expense-tracker", id: "123456" },
          template: { name: "acme/vibe-starter", commit: "a".repeat(40) },
        }),
      );

      const found = await findAppByRepository({
        connectorId,
        owner: "acme",
        name: "expense-tracker",
      });
      expect(found).toEqual(created);
      expect(found).toMatchObject({
        name: "Expense tracker",
        purpose: "Tracks team expenses",
        ownerId: alice,
        repositoryId: "123456",
        defaultBranch: "main",
        template: "acme/vibe-starter",
        templateCommit: "a".repeat(40),
        previewUrl: null,
        liveUrl: null,
      });
      const days = (found!.expiresAt.getTime() - before) / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThanOrEqual(APP_REVERIFICATION_DAYS);
      expect(days).toBeLessThan(APP_REVERIFICATION_DAYS + 1);
      expect(
        await findAppByRepository({
          connectorId: otherConnectorId,
          owner: "acme",
          name: "expense-tracker",
        }),
      ).toBeNull();
    });

    it("keeps a registered repository without template and with an explicit expiry", async () => {
      const expiresAt = new Date("2027-01-01T00:00:00.000Z");
      const created = await createApp(app({ expiresAt }));
      expect(created).toMatchObject({ template: null, templateCommit: null, repositoryId: null });
      expect(created.expiresAt).toEqual(expiresAt);
    });

    it("allows one entry per repository on a connector", async () => {
      const repository = { connectorId, owner: "acme", name: "shared-name", id: "777" };
      await createApp(app({ repository }));

      await expect(createApp(app({ ownerId: bob, repository }))).rejects.toMatchObject(
        uniqueViolation,
      );
      // A renamed repository keeps its host id, so the same id cannot be registered twice.
      await expect(
        createApp(app({ repository: { ...repository, name: "renamed" } })),
      ).rejects.toMatchObject(uniqueViolation);
      await expect(
        createApp(app({ repository: { ...repository, connectorId: otherConnectorId } })),
      ).resolves.toMatchObject({ repositoryName: "shared-name" });
    });

    it("lists only the apps of one owner, newest first", async () => {
      const first = await createApp(app({ ownerId: bob }));
      const second = await createApp(app({ ownerId: bob }));
      await db.app.update({
        where: { id: first.id },
        data: { createdAt: new Date(second.createdAt.getTime() - 1000) },
      });

      const listed = await listAppsByOwner(bob);
      expect(listed.map(({ id }) => id)).toEqual(expect.arrayContaining([second.id, first.id]));
      expect(listed.every(({ ownerId }) => ownerId === bob)).toBe(true);
      expect(listed.findIndex(({ id }) => id === second.id)).toBeLessThan(
        listed.findIndex(({ id }) => id === first.id),
      );
      expect(await listAppsByOwner(`${prefix}-nobody`)).toEqual([]);
    });

    it("updates links without touching omitted ones", async () => {
      const created = await createApp(app());

      const preview = await updateAppLinks(created.id, {
        previewUrl: "https://preview.example.com/pr-1",
      });
      expect(preview).toMatchObject({
        previewUrl: "https://preview.example.com/pr-1",
        liveUrl: null,
      });

      const live = await updateAppLinks(created.id, { liveUrl: "https://app.example.com" });
      expect(live).toMatchObject({
        previewUrl: "https://preview.example.com/pr-1",
        liveUrl: "https://app.example.com",
      });

      const cleared = await updateAppLinks(created.id, { previewUrl: null });
      expect(cleared).toMatchObject({ previewUrl: null, liveUrl: "https://app.example.com" });
    });

    it("refuses to delete a user who still owns apps", async () => {
      const owner = `${prefix}-leaver`;
      await db.user.create({
        data: { id: owner, name: owner, email: `${owner}@example.com`, emailVerified: true },
      });
      const created = await createApp(app({ ownerId: owner }));

      await expect(db.user.delete({ where: { id: owner } })).rejects.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
      expect(await db.app.findUnique({ where: { id: created.id } })).not.toBeNull();
    });

    it("refuses to delete a connector that registered apps still use", async () => {
      const connector = await createConnector("in-use");
      const created = await createApp(
        app({ repository: { connectorId: connector.id, owner: "acme", name: "pinned" } }),
      );

      const error = await runConnectorTransaction((tx) =>
        deleteConnectorConfiguration({ tx, id: connector.id, version: connector.version, actor }),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConnectorError);
      expect(error).toMatchObject({ code: "in_use", status: 409 });
      await expect(db.connector.delete({ where: { id: connector.id } })).rejects.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
      expect(await db.app.findUnique({ where: { id: created.id } })).not.toBeNull();

      await db.app.delete({ where: { id: created.id } });
      await runConnectorTransaction((tx) =>
        deleteConnectorConfiguration({ tx, id: connector.id, version: connector.version, actor }),
      );
      expect(await db.connector.findUnique({ where: { id: connector.id } })).toBeNull();
    });
  },
);
