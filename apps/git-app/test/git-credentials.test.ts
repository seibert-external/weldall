import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGitCredentialSigner,
  GIT_CREDENTIAL_LIFETIME_MS,
  parseGitCredentialKey,
} from "../src/git/credentials.js";
import { redactCredentials } from "../src/redaction.js";

const resource = "https://git-app.example.com/api";
const claims = {
  subject: "user-1",
  appId: "app0001",
  repository: { owner: "acme-apps", name: "app-demo" },
  access: "write" as const,
};

describe("signed git credentials", () => {
  const key = randomBytes(32);

  it("round-trips the claims, expires after five minutes and keeps the wgc_ prefix", () => {
    let now = new Date("2026-11-18T10:00:00.000Z");
    const signer = createGitCredentialSigner({ keys: [key], resource, now: () => now });
    const { password, credential } = signer.issue(claims);
    expect(password).toMatch(/^wgc_[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(credential.expiresAt.getTime() - now.getTime()).toBe(GIT_CREDENTIAL_LIFETIME_MS);
    expect(signer.verify(password)).toEqual({ status: "valid", credential });
    // Redaction recognises the whole credential.
    expect(redactCredentials(`password=${password}`)).toBe("password=[***]");
    now = new Date(now.getTime() + GIT_CREDENTIAL_LIFETIME_MS);
    expect(signer.verify(password)).toEqual({ status: "expired", credential });
  });

  it("issues a fresh id per credential", () => {
    const signer = createGitCredentialSigner({ keys: [key], resource });
    const ids = new Set(Array.from({ length: 20 }, () => signer.issue(claims).credential.id));
    expect(ids.size).toBe(20);
  });

  it("refuses tampered payloads and signatures, other keys and other instances", () => {
    const signer = createGitCredentialSigner({ keys: [key], resource });
    const { password } = signer.issue({ ...claims, access: "read" });
    const [prefixAndKid, payload, signature] = password.split(".") as [string, string, string];
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as unknown[];
    decoded[5] = "w";
    const escalated = `${prefixAndKid}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;
    expect(signer.verify(escalated)).toEqual({ status: "invalid" });
    const flipped = `${prefixAndKid}.${payload}.${signature.slice(0, -2)}${signature.endsWith("AA") ? "BA" : "AA"}`;
    expect(signer.verify(flipped)).toEqual({ status: "invalid" });
    expect(
      createGitCredentialSigner({ keys: [randomBytes(32)], resource }).verify(password),
    ).toEqual({ status: "invalid" });
    expect(
      createGitCredentialSigner({ keys: [key], resource: "https://other.example.com/api" }).verify(
        password,
      ),
    ).toEqual({ status: "invalid" });
    for (const garbage of ["", "wgc_", `ghs_${"a".repeat(36)}`, `${password}x`])
      expect(signer.verify(garbage)).toEqual({ status: "invalid" });
  });

  it("verifies with the previous key during a rotation and signs only with the current one", () => {
    const previous = randomBytes(32);
    const old = createGitCredentialSigner({ keys: [previous], resource }).issue(claims).password;
    const rotated = createGitCredentialSigner({ keys: [key, previous], resource });
    expect(rotated.verify(old).status).toBe("valid");
    const fresh = rotated.issue(claims).password;
    expect(createGitCredentialSigner({ keys: [key], resource }).verify(fresh).status).toBe("valid");
    // Once the previous key is removed, what it signed is no longer accepted.
    expect(createGitCredentialSigner({ keys: [key], resource }).verify(old).status).toBe("invalid");
  });

  it("parses configured keys of at least 32 bytes in base64 or base64url", () => {
    const raw = randomBytes(32);
    expect(parseGitCredentialKey(raw.toString("base64"))?.equals(raw)).toBe(true);
    expect(parseGitCredentialKey(raw.toString("base64url"))?.equals(raw)).toBe(true);
    expect(parseGitCredentialKey(randomBytes(16).toString("base64"))).toBeNull();
    expect(parseGitCredentialKey("not base64 at all!")).toBeNull();
    expect(() => createGitCredentialSigner({ keys: [randomBytes(8)], resource })).toThrow();
  });
});
