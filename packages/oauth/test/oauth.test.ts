import { describe, expect, it } from "vitest";
import { SignJWT, calculateJwkThumbprint, importJWK, type JWTHeaderParameters } from "jose";
import {
  ID_JAG_DRAFT,
  ReplayStore,
  createDpopProof,
  createInMemoryDpopReplayStore,
  generateEs256KeyPair,
  issueAccessToken,
  issueIdJag,
  normalizeHtu,
  signEs256,
  validateEs256KeyPair,
  verifyAccessToken,
  verifyIdJag,
  verifyStrictDpop,
  type DpopKeyPair,
} from "../src/index.js";

const signDpop = async (
  key: DpopKeyPair,
  payload: Record<string, unknown>,
  header: JWTHeaderParameters = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: key.publicJwk,
  },
) => new SignJWT(payload).setProtectedHeader(header).sign(await importJWK(key.privateJwk, "ES256"));

const replaceProtectedHeader = (token: string, header: Record<string, unknown>) => {
  const [, payload, signature] = token.split(".");
  return `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${payload}.${signature}`;
};

const validIdJagClaims = (jkt: string, now: number) => ({
  iss: "https://idp",
  sub: "u",
  aud: "https://as",
  client_id: "c",
  resource: "https://api",
  scope: "read",
  cnf: { jkt },
  jti: "grant-jti",
  iat: now,
  exp: now + 300,
  "urn:weldall:id-jag-draft": ID_JAG_DRAFT,
});

const idJagVerification = (key: DpopKeyPair) => ({
  issuer: "https://idp",
  audience: "https://as",
  resource: "https://api",
  clientId: "c",
  kid: "k",
  publicJwk: key.publicJwk,
  allowedScopes: ["read"],
});

describe("DPoP", () => {
  it("keeps proof JTIs single-use in one process", async () => {
    const replay = createInMemoryDpopReplayStore();
    const reservation = {
      key: "device-thumbprint:proof-jti",
      now: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect(replay.reserve(reservation)).toBe(true);
    expect(replay.reserve(reservation)).toBe(false);
  });

  it("binds request and rejects replay", async () => {
    const key = await generateEs256KeyPair();
    const replay = new ReplayStore();
    const proof = await createDpopProof({
      ...key,
      method: "POST",
      url: "https://example.test/token",
      jti: "once",
    });
    await expect(
      verifyStrictDpop(proof, {
        method: "POST",
        url: "https://example.test/token",
        replay,
        expectedJkt: key.jkt,
      }),
    ).resolves.toMatchObject({ jkt: key.jkt });
    await expect(
      verifyStrictDpop(proof, { method: "POST", url: "https://example.test/token", replay }),
    ).rejects.toThrow("already used");
  });
  it("retains a proof accepted at the age boundary for replay detection", async () => {
    const key = await generateEs256KeyPair();
    const replay = new ReplayStore();
    const proof = await createDpopProof({
      ...key,
      method: "POST",
      url: "https://example.test/token",
      now: 940,
      jti: "boundary",
    });
    const verify = () =>
      verifyStrictDpop(proof, {
        method: "POST",
        url: "https://example.test/token",
        replay,
        now: 1000,
      });
    await expect(verify()).resolves.toMatchObject({ jkt: key.jkt });
    await expect(verify()).rejects.toThrow("already used");
  });

  it("normalizes request query and fragment out of htu", () => {
    expect(normalizeHtu("https://EXAMPLE.test:443/api?limit=5#ignored")).toBe(
      "https://example.test/api",
    );
  });

  it("requires a matching ath for resources", async () => {
    const key = await generateEs256KeyPair();
    const wrong = await createDpopProof({
      ...key,
      method: "GET",
      url: "https://example.test/api",
      accessToken: "token",
    });
    await expect(
      verifyStrictDpop(wrong, {
        method: "GET",
        url: "https://example.test/api",
        replay: new ReplayStore(),
        accessToken: "wrong",
      }),
    ).rejects.toThrow("hash mismatch");

    const missing = await createDpopProof({
      ...key,
      method: "GET",
      url: "https://example.test/api",
    });
    await expect(
      verifyStrictDpop(missing, {
        method: "GET",
        url: "https://example.test/api",
        replay: new ReplayStore(),
        accessToken: "token",
      }),
    ).rejects.toThrow("hash mismatch");
  });

  it.each([
    ["wrong method", "GET", "https://example.test/token", 1_000, "invalid DPoP claims"],
    ["wrong endpoint", "POST", "https://other.test/token", 1_000, "invalid DPoP claims"],
    ["stale iat", "POST", "https://example.test/token", 939, "invalid DPoP claims"],
    ["future iat", "POST", "https://example.test/token", 1_006, "invalid DPoP claims"],
  ])("rejects %s", async (_name, method, url, proofNow, message) => {
    const key = await generateEs256KeyPair();
    const proof = await createDpopProof({
      ...key,
      method: "POST",
      url: "https://example.test/token",
      now: proofNow as number,
    });
    await expect(
      verifyStrictDpop(proof, {
        method: method as string,
        url: url as string,
        replay: new ReplayStore(),
        now: 1_000,
      }),
    ).rejects.toThrow(message as string);
  });

  it("rejects a proof made by a different device key", async () => {
    const expected = await generateEs256KeyPair();
    const attacker = await generateEs256KeyPair();
    const proof = await createDpopProof({
      ...attacker,
      method: "POST",
      url: "https://example.test/token",
    });
    await expect(
      verifyStrictDpop(proof, {
        method: "POST",
        url: "https://example.test/token",
        replay: new ReplayStore(),
        expectedJkt: expected.jkt,
      }),
    ).rejects.toThrow("key mismatch");
  });

  it("rejects private key material in the proof header", async () => {
    const key = await generateEs256KeyPair();
    const signingKey = await importJWK(key.privateJwk, "ES256");
    const proof = await new SignJWT({
      htm: "POST",
      htu: "https://example.test/token",
      iat: Math.floor(Date.now() / 1_000),
      jti: "private-jwk",
    })
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: key.privateJwk })
      .sign(signingKey);
    await expect(
      verifyStrictDpop(proof, {
        method: "POST",
        url: "https://example.test/token",
        replay: new ReplayStore(),
      }),
    ).rejects.toThrow("invalid DPoP header");
  });

  it("rejects ath at a token endpoint where no access token is presented", async () => {
    const key = await generateEs256KeyPair();
    const proof = await createDpopProof({
      ...key,
      method: "POST",
      url: "https://example.test/token",
      accessToken: "unexpected",
    });
    await expect(
      verifyStrictDpop(proof, {
        method: "POST",
        url: "https://example.test/token",
        replay: new ReplayStore(),
      }),
    ).rejects.toThrow("ath is not allowed");
  });

  it("never treats an empty expected thumbprint as an unbound proof", async () => {
    const key = await generateEs256KeyPair();
    const proof = await createDpopProof({
      ...key,
      method: "POST",
      url: "https://example.test/token",
    });
    await expect(
      verifyStrictDpop(proof, {
        method: "POST",
        url: "https://example.test/token",
        replay: new ReplayStore(),
        expectedJkt: "",
      }),
    ).rejects.toThrow("key mismatch");
  });

  it.each([
    ["missing htm", { htu: "https://example.test/token", iat: 1_000, jti: "jti" }],
    ["lowercase htm", { htm: "post", htu: "https://example.test/token", iat: 1_000, jti: "jti" }],
    ["missing htu", { htm: "POST", iat: 1_000, jti: "jti" }],
    [
      "htu query",
      { htm: "POST", htu: "https://example.test/token?admin=true", iat: 1_000, jti: "jti" },
    ],
    [
      "htu fragment",
      { htm: "POST", htu: "https://example.test/token#fragment", iat: 1_000, jti: "jti" },
    ],
    ["missing iat", { htm: "POST", htu: "https://example.test/token", jti: "jti" }],
    [
      "fractional iat",
      { htm: "POST", htu: "https://example.test/token", iat: 1_000.5, jti: "jti" },
    ],
    ["missing jti", { htm: "POST", htu: "https://example.test/token", iat: 1_000 }],
    ["empty jti", { htm: "POST", htu: "https://example.test/token", iat: 1_000, jti: "" }],
    [
      "oversized jti",
      { htm: "POST", htu: "https://example.test/token", iat: 1_000, jti: "j".repeat(129) },
    ],
  ])("rejects malformed claim: %s", async (_name, payload) => {
    const key = await generateEs256KeyPair();
    const proof = await signDpop(key, payload);
    await expect(
      verifyStrictDpop(proof, {
        method: "POST",
        url: "https://example.test/token",
        replay: new ReplayStore(),
        now: 1_000,
      }),
    ).rejects.toMatchObject({ code: "invalid_dpop_proof" });
  });

  it.each([
    ["missing typ", (key: DpopKeyPair) => ({ alg: "ES256", jwk: key.publicJwk })],
    ["wrong typ", (key: DpopKeyPair) => ({ typ: "JWT", alg: "ES256", jwk: key.publicJwk })],
    ["missing jwk", () => ({ typ: "dpop+jwt", alg: "ES256" })],
    [
      "conflicting JWK alg",
      (key: DpopKeyPair) => ({
        typ: "dpop+jwt",
        alg: "ES256",
        jwk: { ...key.publicJwk, alg: "ES384" },
      }),
    ],
    [
      "wrong EC curve",
      (key: DpopKeyPair) => ({
        typ: "dpop+jwt",
        alg: "ES256",
        jwk: { ...key.publicJwk, crv: "P-384" },
      }),
    ],
    [
      "encryption JWK use",
      (key: DpopKeyPair) => ({
        typ: "dpop+jwt",
        alg: "ES256",
        jwk: { ...key.publicJwk, use: "enc" },
      }),
    ],
    [
      "signing public-key operation",
      (key: DpopKeyPair) => ({
        typ: "dpop+jwt",
        alg: "ES256",
        jwk: { ...key.publicJwk, key_ops: ["sign"] },
      }),
    ],
  ])("rejects malformed header: %s", async (_name, makeHeader) => {
    const key = await generateEs256KeyPair();
    const proof = await signDpop(
      key,
      { htm: "POST", htu: "https://example.test/token", iat: 1_000, jti: "jti" },
      makeHeader(key) as JWTHeaderParameters,
    );
    await expect(
      verifyStrictDpop(proof, {
        method: "POST",
        url: "https://example.test/token",
        replay: new ReplayStore(),
        now: 1_000,
      }),
    ).rejects.toMatchObject({ code: "invalid_dpop_proof" });
  });

  it.each([
    ["alg none", { typ: "dpop+jwt", alg: "none" }],
    ["HMAC alg", { typ: "dpop+jwt", alg: "HS256" }],
    ["RSA alg", { typ: "dpop+jwt", alg: "RS256" }],
    ["wrong EC alg", { typ: "dpop+jwt", alg: "ES384" }],
    ["unknown critical header", { typ: "dpop+jwt", alg: "ES256", crit: ["unknown"] }],
  ])("rejects %s before signature processing", async (_name, replacement) => {
    const key = await generateEs256KeyPair();
    const valid = await createDpopProof({
      ...key,
      method: "POST",
      url: "https://example.test/token",
      now: 1_000,
    });
    const proof = replaceProtectedHeader(valid, { ...replacement, jwk: key.publicJwk });
    await expect(
      verifyStrictDpop(proof, {
        method: "POST",
        url: "https://example.test/token",
        replay: new ReplayStore(),
        now: 1_000,
      }),
    ).rejects.toMatchObject({ code: "invalid_dpop_proof" });
  });

  it("normalizes malformed compact proofs to an OAuth error", async () => {
    await expect(
      verifyStrictDpop("not-a-jwt", {
        method: "POST",
        url: "https://example.test/token",
        replay: new ReplayStore(),
      }),
    ).rejects.toMatchObject({ code: "invalid_dpop_proof" });
  });

  it("rejects a tampered proof signature", async () => {
    const key = await generateEs256KeyPair();
    const proof = await createDpopProof({
      ...key,
      method: "POST",
      url: "https://example.test/token",
    });
    const [header, payload, signature] = proof.split(".");
    const tampered = `${header}.${payload}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
    await expect(
      verifyStrictDpop(tampered, {
        method: "POST",
        url: "https://example.test/token",
        replay: new ReplayStore(),
      }),
    ).rejects.toThrow("invalid DPoP signature");
  });

  it("has inclusive clock-skew boundaries", async () => {
    const key = await generateEs256KeyPair();
    for (const [iat, jti] of [
      [940, "oldest"],
      [1_005, "newest"],
    ] as const) {
      const proof = await createDpopProof({
        ...key,
        method: "POST",
        url: "https://example.test/token",
        now: iat,
        jti,
      });
      await expect(
        verifyStrictDpop(proof, {
          method: "POST",
          url: "https://example.test/token",
          replay: new ReplayStore(),
          now: 1_000,
        }),
      ).resolves.toMatchObject({ jkt: key.jkt });
    }
  });

  it("atomically accepts exactly one parallel replay", async () => {
    const key = await generateEs256KeyPair();
    const replay = new ReplayStore();
    const proof = await createDpopProof({
      ...key,
      method: "POST",
      url: "https://example.test/token",
      jti: "parallel",
    });
    const results = await Promise.allSettled([
      verifyStrictDpop(proof, { method: "POST", url: "https://example.test/token", replay }),
      verifyStrictDpop(proof, { method: "POST", url: "https://example.test/token", replay }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("normalizes only safe URI components", () => {
    expect(normalizeHtu("https://EXAMPLE.test:443/a/../token?x=1#fragment")).toBe(
      "https://example.test/token",
    );
    expect(normalizeHtu("https://example.test:8443/token")).toBe("https://example.test:8443/token");
    expect(() => normalizeHtu("http://example.test/token")).toThrow("invalid htu scheme");
    expect(() => normalizeHtu("https://user@example.test/token")).toThrow(
      "must not contain credentials",
    );
  });
});
describe("issuer keys", () => {
  it("matches the RFC 7638 section 3.1 SHA-256 vector", async () => {
    const n = [
      "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAt",
      "VT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn6",
      "4tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FD",
      "W2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n9",
      "1CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINH",
      "aQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
    ].join("");
    await expect(
      calculateJwkThumbprint(
        { kty: "RSA", n, e: "AQAB", alg: "RS256", kid: "2011-04-29" },
        "sha256",
      ),
    ).resolves.toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
  });

  it("rejects mismatched environment key pairs", async () => {
    const first = await generateEs256KeyPair();
    const second = await generateEs256KeyPair();
    await expect(validateEs256KeyPair(first.privateJwk, second.publicJwk)).rejects.toThrow(
      "mismatch",
    );
  });
});

describe("ID-JAG draft-04", () => {
  it("pins all target claims", async () => {
    const key = await generateEs256KeyPair();
    const token = await issueIdJag({
      issuer: "https://idp",
      subject: "u",
      audience: "https://as",
      clientId: "c",
      resource: "https://api",
      scopes: ["read"],
      jkt: key.jkt,
      kid: "k",
      privateJwk: key.privateJwk,
    });
    const p = await verifyIdJag(token, {
      issuer: "https://idp",
      audience: "https://as",
      resource: "https://api",
      clientId: "c",
      kid: "k",
      publicJwk: key.publicJwk,
      allowedScopes: ["read"],
    });
    expect(p.cnf.jkt).toBe(key.jkt);
  });

  it("rejects a bearer downgrade without cnf.jkt", async () => {
    const key = await generateEs256KeyPair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signEs256(
      {
        iss: "https://idp",
        sub: "u",
        aud: "https://as",
        client_id: "c",
        resource: "https://api",
        scope: "read",
        jti: "unbound-grant",
        iat: now,
        exp: now + 300,
      },
      { kid: "k", privateJwk: key.privateJwk, typ: "oauth-id-jag+jwt" },
    );
    await expect(
      verifyIdJag(token, {
        issuer: "https://idp",
        audience: "https://as",
        resource: "https://api",
        clientId: "c",
        kid: "k",
        publicJwk: key.publicJwk,
        allowedScopes: ["read"],
      }),
    ).rejects.toThrow("invalid ID-JAG claims");
  });

  it("requires bounded iat and exp claims", async () => {
    const key = await generateEs256KeyPair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signEs256(
      {
        iss: "https://idp",
        sub: "u",
        aud: "https://as",
        client_id: "c",
        resource: "https://api",
        scope: "read",
        cnf: { jkt: key.jkt },
        jti: "missing-exp",
        iat: now,
      },
      { kid: "k", privateJwk: key.privateJwk, typ: "oauth-id-jag+jwt" },
    );
    await expect(verifyIdJag(token, idJagVerification(key))).rejects.toThrow();
  });

  it.each([
    ["array audience", (_key: DpopKeyPair) => ({ aud: ["https://as", "https://attacker"] })],
    ["wrong resource", () => ({ resource: "https://attacker/api" })],
    ["wrong client", () => ({ client_id: "attacker" })],
    ["empty subject", () => ({ sub: "" })],
    ["empty jti", () => ({ jti: "" })],
    ["oversized jti", () => ({ jti: "j".repeat(129) })],
    ["string cnf", () => ({ cnf: "bound" })],
    ["array cnf", () => ({ cnf: ["bound"] })],
    ["empty thumbprint", () => ({ cnf: { jkt: "" } })],
    ["malformed thumbprint", () => ({ cnf: { jkt: "not-a-thumbprint" } })],
    ["foreign confirmation method", () => ({ cnf: { jku: "https://attacker/jwks" } })],
    ["empty scope", () => ({ scope: "" })],
    ["duplicate scopes", () => ({ scope: "read read" })],
    ["control character in scope", () => ({ scope: "read\nadmin" })],
    ["wrong draft", () => ({ "urn:weldall:id-jag-draft": "draft-03" })],
    ["expired token", (_key: DpopKeyPair, now: number) => ({ iat: now - 310, exp: now - 10 })],
    ["future iat", (_key: DpopKeyPair, now: number) => ({ iat: now + 30, exp: now + 330 })],
    ["future nbf", (_key: DpopKeyPair, now: number) => ({ nbf: now + 30 })],
    ["excessive lifetime", (_key: DpopKeyPair, now: number) => ({ exp: now + 301 })],
  ])("rejects malformed target claim: %s", async (_name, patch) => {
    const key = await generateEs256KeyPair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signEs256(
      { ...validIdJagClaims(key.jkt, now), ...patch(key, now) },
      { kid: "k", privateJwk: key.privateJwk, typ: "oauth-id-jag+jwt" },
    );
    await expect(verifyIdJag(token, idJagVerification(key))).rejects.toMatchObject({
      code: "invalid_grant",
    });
  });

  it("distinguishes scope escalation from malformed grants", async () => {
    const key = await generateEs256KeyPair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signEs256(
      { ...validIdJagClaims(key.jkt, now), scope: "admin" },
      { kid: "k", privateJwk: key.privateJwk, typ: "oauth-id-jag+jwt" },
    );
    await expect(verifyIdJag(token, idJagVerification(key))).rejects.toMatchObject({
      code: "invalid_scope",
    });
  });

  it.each([
    ["wrong kid", { kid: "attacker", typ: "oauth-id-jag+jwt" }],
    ["wrong typ", { kid: "k", typ: "JWT" }],
  ])("rejects %s", async (_name, header) => {
    const key = await generateEs256KeyPair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signEs256(validIdJagClaims(key.jkt, now), {
      ...header,
      privateJwk: key.privateJwk,
    });
    await expect(verifyIdJag(token, idJagVerification(key))).rejects.toMatchObject({
      code: "invalid_grant",
    });
  });

  it("rejects a tampered or truncated assertion", async () => {
    const key = await generateEs256KeyPair();
    const token = await issueIdJag({
      issuer: "https://idp",
      subject: "u",
      audience: "https://as",
      clientId: "c",
      resource: "https://api",
      scopes: ["read"],
      jkt: key.jkt,
      kid: "k",
      privateJwk: key.privateJwk,
    });
    const [header, payload, signature] = token.split(".");
    const tampered = `${header}.${payload}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
    await expect(verifyIdJag(tampered, idJagVerification(key))).rejects.toMatchObject({
      code: "invalid_grant",
    });
    await expect(verifyIdJag(`${header}.${payload}`, idJagVerification(key))).rejects.toMatchObject(
      {
        code: "invalid_grant",
      },
    );
  });

  it("refuses to issue an unbound ID-JAG", async () => {
    const key = await generateEs256KeyPair();
    await expect(
      issueIdJag({
        issuer: "https://idp",
        subject: "u",
        audience: "https://as",
        clientId: "c",
        resource: "https://api",
        scopes: ["read"],
        jkt: "",
        kid: "k",
        privateJwk: key.privateJwk,
      }),
    ).rejects.toThrow("invalid ID-JAG issuance claims");
  });
});

describe("DPoP access tokens", () => {
  it("requires an exact audience and canonical bound claims", async () => {
    const issuer = await generateEs256KeyPair();
    const device = await generateEs256KeyPair();
    const now = Math.floor(Date.now() / 1000);
    const base = {
      iss: "https://as",
      sub: "user",
      aud: "https://api",
      client_id: "client",
      scope: "read",
      cnf: { jkt: device.jkt },
      jti: "token-jti",
      iat: now,
      exp: now + 600,
    };
    const verify = (token: string) =>
      verifyAccessToken(token, {
        issuer: "https://as",
        resource: "https://api",
        kid: "issuer",
        publicJwk: issuer.publicJwk,
        clientId: "client",
        requiredScopes: ["read"],
      });
    for (const patch of [
      { aud: ["https://api", "https://attacker"] },
      { cnf: { jkt: "" } },
      { scope: "read read" },
    ]) {
      const token = await signEs256(
        { ...base, ...patch },
        {
          kid: "issuer",
          privateJwk: issuer.privateJwk,
          typ: "at+jwt",
        },
      );
      await expect(verify(token)).rejects.toMatchObject({
        code: expect.stringMatching(/invalid_(grant|token)/),
      });
    }
  });

  it("keeps insufficient scope distinct from an invalid token", async () => {
    const issuer = await generateEs256KeyPair();
    const device = await generateEs256KeyPair();
    const token = await issueAccessToken({
      issuer: "https://as",
      subject: "user",
      resource: "https://api",
      clientId: "client",
      scopes: ["read"],
      jkt: device.jkt,
      kid: "issuer",
      privateJwk: issuer.privateJwk,
    });
    await expect(
      verifyAccessToken(token, {
        issuer: "https://as",
        resource: "https://api",
        kid: "issuer",
        publicJwk: issuer.publicJwk,
        clientId: "client",
        requiredScopes: ["write"],
      }),
    ).rejects.toMatchObject({ code: "insufficient_scope", status: 403 });
  });
});
