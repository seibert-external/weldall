import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "@weldall/db";
import {
  APP_REVERIFICATION_DAYS,
  createApp,
  type NewApp,
} from "../src/server/app-registry/service";
import { mutateResource, PrimitiveMutationError } from "../src/server/domain/primitive-mutations";

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
const actor = {
  type: "user" as const,
  id: `${prefix}-admin`,
  requestId: prefix,
  source: "admin_api" as const,
};
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
let resourceId: string;
let otherResourceId: string;
let n = 0;

const createResource = (suffix: string) =>
  db.downstreamResource.create({
    data: {
      key: `${prefix}-${suffix}`,
      name: "Git app",
      resourceIdentifier: `https://${prefix}-${suffix}.example.com/api`,
      authorizationServer: `https://${prefix}-${suffix}.example.com`,
      downstreamClientId: `${prefix}-${suffix}`,
      createdBy: actor.id,
      updatedBy: actor.id,
    },
  });

const app = (overrides: Partial<NewApp> = {}): NewApp => ({
  name: "Expense tracker",
  purpose: "Tracks team expenses",
  ownerId: alice,
  repository: { resourceId, owner: "acme", name: `app-${++n}` },
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
      resourceId = (await createResource("github")).id;
      otherResourceId = (await createResource("forgejo")).id;
    });

    afterAll(async () => {
      await db.app.deleteMany({ where: { ownerId: { startsWith: prefix } } });
      await db.downstreamResource.deleteMany({ where: { key: { startsWith: prefix } } });
      await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
      await db.auditEvent.deleteMany({ where: { actorId: { startsWith: prefix } } });
    });

    it("creates an entry on the Git app's resource with the default expiry", async () => {
      const before = Date.now();
      const created = await createApp(
        app({
          repository: {
            resourceId,
            owner: "acme",
            name: "expense-tracker",
            id: "123456",
            webUrl: "https://git.example.com/acme/expense-tracker",
          },
          template: { name: "acme/vibe-starter", commit: "a".repeat(40) },
        }),
      );

      const found = await db.app.findUnique({
        where: {
          resourceId_repositoryOwner_repositoryName: {
            resourceId,
            repositoryOwner: "acme",
            repositoryName: "expense-tracker",
          },
        },
      });
      expect(found).toEqual(created);
      expect(found).toMatchObject({
        name: "Expense tracker",
        purpose: "Tracks team expenses",
        ownerId: alice,
        resourceId,
        repositoryId: "123456",
        repositoryWebUrl: "https://git.example.com/acme/expense-tracker",
        defaultBranch: "main",
        template: "acme/vibe-starter",
        templateCommit: "a".repeat(40),
        previewUrl: null,
        liveUrl: null,
      });
      const days = (found!.expiresAt.getTime() - before) / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThanOrEqual(APP_REVERIFICATION_DAYS);
      expect(days).toBeLessThan(APP_REVERIFICATION_DAYS + 1);
    });

    it("keeps a registered repository without template and with an explicit expiry", async () => {
      const expiresAt = new Date("2027-01-01T00:00:00.000Z");
      const created = await createApp(app({ expiresAt }));
      expect(created).toMatchObject({ template: null, templateCommit: null, repositoryId: null });
      expect(created.expiresAt).toEqual(expiresAt);
    });

    it("allows one entry per repository on a resource", async () => {
      const repository = { resourceId, owner: "acme", name: "shared-name", id: "777" };
      await createApp(app({ repository }));

      await expect(createApp(app({ ownerId: bob, repository }))).rejects.toMatchObject(
        uniqueViolation,
      );
      // A renamed repository keeps its host id, so the same id cannot be registered twice.
      await expect(
        createApp(app({ repository: { ...repository, name: "renamed" } })),
      ).rejects.toMatchObject(uniqueViolation);
      await expect(
        createApp(app({ repository: { ...repository, resourceId: otherResourceId } })),
      ).resolves.toMatchObject({ repositoryName: "shared-name" });
    });

    it("requires the resource of a Git app", async () => {
      await expect(
        db.app.create({
          data: {
            name: "x",
            purpose: "x",
            ownerId: alice,
            repositoryOwner: "acme",
            repositoryName: "no-resource",
            defaultBranch: "main",
            expiresAt: new Date(),
          } as never,
        }),
      ).rejects.toThrow();
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

    it("refuses to delete a resource that registered apps still use", async () => {
      const resource = await createResource("in-use");
      const created = await createApp(
        app({ repository: { resourceId: resource.id, owner: "acme", name: "pinned" } }),
      );
      const remove = () =>
        db.$transaction((tx) =>
          mutateResource(
            tx,
            { action: "delete", id: resource.id, expectedVersion: resource.version },
            actor,
          ),
        );

      const error = await remove().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PrimitiveMutationError);
      expect(error).toMatchObject({ code: "CONFLICT" });
      await expect(
        db.downstreamResource.delete({ where: { id: resource.id } }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(await db.app.findUnique({ where: { id: created.id } })).not.toBeNull();

      await db.app.delete({ where: { id: created.id } });
      await remove();
      expect(await db.downstreamResource.findUnique({ where: { id: resource.id } })).toBeNull();
    });
  },
);
