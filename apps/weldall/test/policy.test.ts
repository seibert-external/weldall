import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import { generateEs256KeyPair, issueIdJag, verifyIdJag } from "@weldall/sdk";
import { importJWK, jwtVerify } from "jose";
import { normalizeEmail, parseScopeKey } from "../src/server/admin/service.js";
import { signWeldallJwt } from "../src/server/oauth/jwt.js";
import {
  assignedScopesFor,
  exchangePolicyFor,
  resourceRegistryFor,
} from "../src/server/policy/resources.js";

describe("Weldall signing identity", () => {
  it("uses the same env ES256 key for OAuth JWTs and ID-JAGs", async () => {
    const key = await generateEs256KeyPair();
    process.env.WELDALL_SIGNING_PRIVATE_JWK = JSON.stringify(key.privateJwk);
    process.env.WELDALL_SIGNING_PUBLIC_JWK = JSON.stringify(key.publicJwk);
    process.env.WELDALL_SIGNING_KID = "weldall-test";
    const oauthToken = await signWeldallJwt({
      iss: "https://idp",
      sub: "user",
      aud: "https://api",
      scope: "read",
      iat: 1,
      exp: 4_000_000_000,
    });
    const verified = await jwtVerify(oauthToken, await importJWK(key.publicJwk, "ES256"), {
      algorithms: ["ES256"],
      issuer: "https://idp",
      audience: "https://api",
      typ: "at+jwt",
    });
    expect(verified.protectedHeader.kid).toBe("weldall-test");

    const jag = await issueIdJag({
      issuer: "https://idp",
      subject: "user",
      email: "user@example.com",
      audience: "https://as",
      clientId: "client",
      resource: "https://api",
      scopes: ["read"],
      jkt: key.jkt,
      kid: "weldall-test",
      privateJwk: key.privateJwk,
    });
    await expect(
      verifyIdJag(jag, {
        issuer: "https://idp",
        audience: "https://as",
        resource: "https://api",
        clientId: "client",
        kid: "weldall-test",
        publicJwk: key.publicJwk,
        allowedScopes: ["read"],
      }),
    ).resolves.toMatchObject({
      sub: "user",
      email: "user@example.com",
      email_verified: true,
    });
  });
});

describe("database-backed policy", () => {
  it("emits every active resource and derives granted scopes independently from assignments", async () => {
    const id = randomUUID();
    const email = ` Policy-${id}@Example.com `;
    const [readScope, adminScope] = await Promise.all([
      db.scope.findUniqueOrThrow({ where: { key: "expenses:read" } }),
      db.scope.findUniqueOrThrow({ where: { key: "weldall:administer" } }),
    ]);
    const resource = await db.downstreamResource.create({
      data: {
        key: `shared-${id}`,
        name: "Shared scope test",
        resourceIdentifier: `https://shared-${id}.example/api`,
        authorizationServer: `https://shared-${id}.example`,
        downstreamClientId: "shared-test-client",
        createdBy: "policy-test",
        updatedBy: "policy-test",
        requestPrefixes: {
          create: {
            urlPrefix: `https://shared-${id}.example/api`,
            createdBy: "policy-test",
          },
        },
        scopes: { create: { scopeId: readScope.id } },
      },
    });
    const assignment = await db.emailScopeAssignment.create({
      data: {
        normalizedEmail: normalizeEmail(email),
        createdBy: "policy-test",
        updatedBy: "policy-test",
        grants: {
          create: [readScope, adminScope].map((scope) => ({
            id: randomUUID(),
            scopeId: scope.id,
            createdBy: "policy-test",
          })),
        },
      },
    });
    try {
      await expect(assignedScopesFor(email)).resolves.toEqual([
        "expenses:read",
        "weldall:administer",
      ]);
      const registry = await resourceRegistryFor(email);
      expect(registry).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "expenses",
            supportedScopes: expect.arrayContaining(["expenses:read"]),
            grantedScopes: ["expenses:read"],
          }),
          expect.objectContaining({
            key: resource.key,
            supportedScopes: ["expenses:read"],
            grantedScopes: ["expenses:read"],
          }),
        ]),
      );
      const policy = await exchangePolicyFor({
        email,
        resourceIdentifier: resource.resourceIdentifier,
        authorizationServer: resource.authorizationServer,
      });
      expect(policy).toMatchObject({
        supportedScopes: ["expenses:read"],
        grantedScopes: ["expenses:read"],
      });
      await expect(
        exchangePolicyFor({
          email,
          resourceIdentifier: resource.resourceIdentifier,
          authorizationServer: "https://mismatched.example",
        }),
      ).resolves.toBeNull();

      const unknownRegistry = await resourceRegistryFor(`unknown-${id}@example.com`);
      expect(unknownRegistry.length).toBeGreaterThanOrEqual(2);
      expect(unknownRegistry.every((entry) => entry.grantedScopes.length === 0)).toBe(true);

      await db.downstreamResource.update({ where: { id: resource.id }, data: { enabled: false } });
      await expect(assignedScopesFor(email)).resolves.toEqual([
        "expenses:read",
        "weldall:administer",
      ]);
      expect((await resourceRegistryFor(email)).some((entry) => entry.key === resource.key)).toBe(
        false,
      );
    } finally {
      await db.emailScopeAssignment.delete({ where: { id: assignment.id } });
      await db.downstreamResource.delete({ where: { id: resource.id } });
    }
  });

  it("rejects ambiguous email and scope identifiers", () => {
    expect(() => normalizeEmail("not-an-email")).toThrow("valid email");
    expect(() => parseScopeKey("Expenses:Read")).toThrow("lowercase");
    expect(normalizeEmail(" Alice@Example.com ")).toBe("alice@example.com");
  });
});
