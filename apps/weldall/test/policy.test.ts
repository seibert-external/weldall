import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import { generateEs256KeyPair, issueIdJag, verifyIdJag } from "@weldall/oauth";
import { importJWK, jwtVerify } from "jose";
import { normalizeEmail, parseScopeKey } from "../src/server/admin/service.js";
import { signWeldallJwt } from "../src/server/oauth/jwt.js";
import { grantsFor } from "../src/server/policy/resources.js";

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
    ).resolves.toMatchObject({ sub: "user" });
  });
});

describe("database-backed policy", () => {
  it("normalizes identities and emits only scopes supported by a downstream resource", async () => {
    const id = randomUUID();
    const email = ` Policy-${id}@Example.com `;
    const [readScope, adminScope] = await Promise.all([
      db.scope.findUniqueOrThrow({ where: { key: "expenses:read" } }),
      db.scope.findUniqueOrThrow({ where: { key: "weldall:administer" } }),
    ]);
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
      await expect(grantsFor(email)).resolves.toEqual([
        expect.objectContaining({ name: "expenses", scopes: ["expenses:read"] }),
      ]);
      await expect(grantsFor(`unknown-${id}@example.com`)).resolves.toEqual([]);
    } finally {
      await db.emailScopeAssignment.delete({ where: { id: assignment.id } });
    }
  });

  it("rejects ambiguous email and scope identifiers", () => {
    expect(() => normalizeEmail("not-an-email")).toThrow("valid email");
    expect(() => parseScopeKey("Expenses:Read")).toThrow("lowercase");
    expect(normalizeEmail(" Alice@Example.com ")).toBe("alice@example.com");
  });
});
