import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import { createApp } from "../src/server/app-registry/service";
import type { AuthorizedConnectorActor } from "../src/server/connectors/contracts";
import {
  GIT_CREDENTIAL_ISSUE_LIMIT_PER_MINUTE,
  GIT_CREDENTIAL_LIFETIME_MS,
  GIT_CREDENTIAL_USERNAME,
  issueGitCredential,
  verifyGitCredential,
} from "../src/server/git-proxy/credentials";

const target = "postgresql://postgres@localhost:5433/postgres";
// Use the operator-approved local database or CI's existing disposable test service; never reset either here.
const approvedTarget =
  process.env.POSTGRES_URL === target ||
  /^postgresql:\/\/postgres@localhost:5433\/weldall_connector_test_[a-f0-9]{32}$/.test(
    process.env.POSTGRES_URL ?? "",
  ) ||
  (process.env.CI === "true" &&
    process.env.POSTGRES_URL === "postgresql://postgres:postgres@localhost:5432/postgres");
const prefix = `gitcred-${randomUUID()}`;
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
const carol = `${prefix}-carol`;
const key = `${prefix}-github`;
const disabledKey = `${prefix}-off`;
const scopedKey = `${prefix}-scoped`;
const scopeKey = `gitcred${prefix.slice(8, 16)}:apps`;

const person = (id: string, scopeKeys: string[] = []): AuthorizedConnectorActor =>
  ({ type: "user", id, email: `${id}@example.com`, requestId: randomUUID(), scopeKeys }) as never;
const path = (connector: string, name: string) => `git/${connector}/Acme/${name}.git`;

async function auditFor(actorId: string) {
  return db.auditEvent.findMany({
    where: { actorId, eventType: { startsWith: "git_credential." } },
    orderBy: { occurredAt: "asc" },
  });
}

describe.skipIf(!approvedTarget)(
  "git credentials on explicitly selected disposable PostgreSQL",
  () => {
    beforeAll(async () => {
      if (!approvedTarget) throw new Error("Unsafe database target");
      for (const id of [alice, bob, carol])
        await db.user.create({
          data: { id, name: id, email: `${id}@example.com`, emailVerified: true },
        });
      const connector = async (connectorKey: string, enabled: boolean) =>
        (
          await db.connector.create({
            data: {
              key: connectorKey,
              name: "Git host",
              providerType: "github-app",
              enabled,
              providerConfig: {},
              envelopeProvider: "LOCAL_ENV",
              createdBy: alice,
              updatedBy: alice,
            },
          })
        ).id;
      const github = await connector(key, true);
      const disabled = await connector(disabledKey, false);
      const scoped = await connector(scopedKey, true);
      const scope = await db.scope.create({
        data: { key: scopeKey, description: "Apps", createdBy: alice, updatedBy: alice },
      });
      await db.connectorRequiredScope.create({ data: { connectorId: scoped, scopeId: scope.id } });
      const app = (
        connectorId: string,
        name: string,
        ownerId = alice,
        commit: string | null = "c".repeat(40),
      ) =>
        createApp({
          name,
          purpose: "Test",
          ownerId,
          repository: { connectorId, owner: "acme", name },
          defaultBranch: "main",
          template: { name: "starter", commit },
        });
      await app(github, "ready");
      await app(github, "pending", alice, null);
      await app(github, "bobs", bob);
      await app(github, "carols", carol);
      await app(disabled, "ready");
      await app(scoped, "ready");
    });

    afterAll(async () => {
      await db.gitCredential.deleteMany({ where: { userId: { startsWith: prefix } } });
      await db.app.deleteMany({ where: { ownerId: { startsWith: prefix } } });
      await db.connector.deleteMany({ where: { key: { startsWith: prefix } } });
      await db.scope.deleteMany({ where: { key: scopeKey } });
      await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
      await db.auditEvent.deleteMany({ where: { actorId: { startsWith: prefix } } });
    });

    it("issues a hashed, app-bound credential and audits it without the secret", async () => {
      const before = Date.now();
      // The owner and repository in the path match the registry regardless of case.
      const issued = await issueGitCredential({
        actor: person(alice),
        input: { path: `/${path(key, "READY")}`, access: "write" },
      });
      expect(issued.username).toBe(GIT_CREDENTIAL_USERNAME);
      expect(issued.password).toMatch(/^wgc_[a-z0-9]+\.[A-Za-z0-9_-]{43}$/);
      const lifetime = Date.parse(issued.expiresAt) - before;
      expect(lifetime).toBeGreaterThanOrEqual(GIT_CREDENTIAL_LIFETIME_MS - 1_000);
      expect(lifetime).toBeLessThanOrEqual(GIT_CREDENTIAL_LIFETIME_MS + 1_000);

      const id = issued.password.slice(4, issued.password.indexOf("."));
      const row = await db.gitCredential.findUniqueOrThrow({
        where: { id },
        include: { app: true },
      });
      expect(row).toMatchObject({ userId: alice, access: "WRITE" });
      expect(row.app.repositoryName).toBe("ready");
      expect(Buffer.from(row.secretHash)).toHaveLength(32);
      expect(JSON.stringify(row)).not.toContain(
        issued.password.slice(issued.password.indexOf(".") + 1),
      );

      const [entry] = await auditFor(alice);
      expect(entry).toMatchObject({
        eventType: "git_credential.issued",
        outcome: "success",
        subjectType: "app",
        subjectId: row.appId,
      });
      expect(entry!.metadata).toMatchObject({
        credentialId: id,
        access: "write",
        repositoryName: "ready",
      });
      expect(JSON.stringify(entry)).not.toContain(issued.password);

      await expect(verifyGitCredential(issued.password)).resolves.toEqual({
        status: "valid",
        credential: {
          id,
          userId: alice,
          email: `${alice}@example.com`,
          appId: row.appId,
          access: "write",
          expiresAt: new Date(issued.expiresAt),
        },
      });
      await expect(
        verifyGitCredential(issued.password, new Date(Date.parse(issued.expiresAt))),
      ).resolves.toMatchObject({ status: "expired", credential: { id } });
    });

    it("refuses tampered, foreign-format and unknown credentials", async () => {
      const { password } = await issueGitCredential({
        actor: person(alice),
        input: { path: path(key, "ready"), access: "read" },
      });
      const dot = password.indexOf(".");
      const flipped = `${password.slice(0, -1)}${password.endsWith("A") ? "B" : "A"}`;
      for (const candidate of [
        flipped,
        `${password.slice(0, 4)}${"x".repeat(dot - 4)}${password.slice(dot)}`,
        password.slice(4),
        `ghs_${password.slice(4)}`,
        "",
        `${password} `,
      ])
        await expect(verifyGitCredential(candidate)).resolves.toEqual({ status: "invalid" });
    });

    it.each([
      ["another person's app", alice, path(key, "bobs"), "not_found"],
      ["an unknown repository", alice, path(key, "missing"), "not_found"],
      ["an unknown connector", alice, path(`${prefix}-nope`, "ready"), "not_found"],
      ["a repository still being created", alice, path(key, "pending"), "repository_not_ready"],
      ["a disabled connector", alice, path(disabledKey, "ready"), "disabled"],
      ["a connector the caller may not use", alice, path(scopedKey, "ready"), "connection_denied"],
      ["a path with an endpoint", alice, `${path(key, "ready")}/info/refs`, "invalid_request"],
    ])("refuses %s and audits the denial", async (_name, actorId, requested, code) => {
      const count = (await auditFor(actorId)).length;
      await expect(
        issueGitCredential({ actor: person(actorId), input: { path: requested, access: "write" } }),
      ).rejects.toMatchObject({ code });
      const entries = await auditFor(actorId);
      expect(entries).toHaveLength(count + 1);
      expect(entries.at(-1)).toMatchObject({
        eventType: "git_credential.denied",
        outcome: "denied",
      });
      if (code === "connection_denied")
        expect(entries.at(-1)!.reasonCode).toBe("scope_not_granted");
      // Another person's app is not linked to the caller's rejection.
      if (requested.includes("bobs")) expect(entries.at(-1)!.subjectId).toBeNull();
    });

    it("issues for a scoped connector once the caller holds its scope, never for machines", async () => {
      await expect(
        issueGitCredential({
          actor: person(alice, [scopeKey]),
          input: { path: path(scopedKey, "ready"), access: "read" },
        }),
      ).resolves.toMatchObject({ username: GIT_CREDENTIAL_USERNAME });
      await expect(
        issueGitCredential({
          actor: { ...person(alice), type: "machine" },
          input: { path: path(key, "ready"), access: "read" },
        }),
      ).rejects.toMatchObject({ code: "connection_denied" });
    });

    it("limits issuance per person and minute and deletes expired credentials lazily", async () => {
      const app = await db.app.findFirstOrThrow({ where: { ownerId: carol } });
      const stale = await db.gitCredential.create({
        data: {
          secretHash: Buffer.alloc(32),
          userId: carol,
          appId: app.id,
          access: "READ",
          createdAt: new Date(Date.now() - 2 * GIT_CREDENTIAL_LIFETIME_MS),
          expiresAt: new Date(Date.now() - GIT_CREDENTIAL_LIFETIME_MS),
        },
      });
      const issue = () =>
        issueGitCredential({
          actor: person(carol),
          input: { path: path(key, "carols"), access: "read" },
        });
      for (let i = 0; i < GIT_CREDENTIAL_ISSUE_LIMIT_PER_MINUTE; i += 1) await issue();
      expect(await db.gitCredential.findUnique({ where: { id: stale.id } })).toBeNull();
      await expect(issue()).rejects.toMatchObject({ code: "rate_limit", status: 429 });
      expect((await auditFor(carol)).at(-1)).toMatchObject({ eventType: "git_credential.denied" });
    });
  },
);
