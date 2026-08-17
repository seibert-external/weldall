import { beforeAll, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { calculateJkt, createBrowserDpopProof, normalizeHtu } from "../src/index.js";

beforeAll(() => {
  if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
});

describe("browser DPoP", () => {
  it("uses a non-exportable P-256 private key, RFC 7638 JKT and ath-bound proof", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("jwk", pair.privateKey)).rejects.toThrow();
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const jkt = await calculateJkt(publicJwk);
    expect(jkt).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const proof = await createBrowserDpopProof({
      privateKey: pair.privateKey,
      publicJwk,
      method: "post",
      url: "https://api.example.test/path?x=1",
      accessToken: "access-token",
    });
    const [encodedHeader, encodedPayload, signature] = proof.split(".");
    const decode = (value: string) =>
      JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(
            atob(
              value
                .replaceAll("-", "+")
                .replaceAll("_", "/")
                .padEnd(Math.ceil(value.length / 4) * 4, "="),
            ),
            (character) => character.charCodeAt(0),
          ),
        ),
      );
    expect(decode(encodedHeader!)).toMatchObject({ alg: "ES256", typ: "dpop+jwt" });
    expect(decode(encodedHeader!)).toMatchObject({
      jwk: { kty: "EC", crv: "P-256", x: expect.any(String), y: expect.any(String) },
    });
    expect((decode(encodedHeader!).jwk as JsonWebKey).ext).toBeUndefined();
    expect(decode(encodedPayload!)).toMatchObject({
      htm: "POST",
      htu: "https://api.example.test/path",
      ath: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
  });

  it("refuses unsafe target URLs", () => {
    expect(() => normalizeHtu("http://api.example.test/path")).toThrow("HTTPS");
    expect(() => normalizeHtu("https://user@api.example.test/path")).toThrow("credentials");
    expect(() => normalizeHtu("https://api.example.test/path#secret")).toThrow("fragment");
    expect(() => normalizeHtu("https://api.example.test/api/%2F..%2Fadmin")).toThrow(
      "percent encoding",
    );
  });
});
