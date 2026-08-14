import { afterEach, describe, expect, it } from "vitest";
import { createDpopProof, generateEs256KeyPair, verifyStrictDpop } from "@weldall/sdk";
import { decodeProtectedHeader } from "jose";
import { MACHINE_TOKEN_TYP } from "@weldall/sdk";
import { WELDALL_ISSUER, WELDALL_RESOURCE } from "../src/server/oauth/constants";
import { signWeldallJwt } from "../src/server/oauth/jwt";
import { canonicalIacRequestUrl, verifyWeldallMachineToken } from "../src/server/iac/auth";

const prior = {
  kid: process.env.WELDALL_SIGNING_KID,
  privateJwk: process.env.WELDALL_SIGNING_PRIVATE_JWK,
  publicJwk: process.env.WELDALL_SIGNING_PUBLIC_JWK,
};

afterEach(() => {
  if (prior.kid === undefined) delete process.env.WELDALL_SIGNING_KID;
  else process.env.WELDALL_SIGNING_KID = prior.kid;
  if (prior.privateJwk === undefined) delete process.env.WELDALL_SIGNING_PRIVATE_JWK;
  else process.env.WELDALL_SIGNING_PRIVATE_JWK = prior.privateJwk;
  if (prior.publicJwk === undefined) delete process.env.WELDALL_SIGNING_PUBLIC_JWK;
  else process.env.WELDALL_SIGNING_PUBLIC_JWK = prior.publicJwk;
});

describe("IaC DPoP request URL", () => {
  it("uses the public issuer when Next.js exposes a reverse-proxy upstream URL", async () => {
    const key = await generateEs256KeyPair();
    const endpoint = `${WELDALL_ISSUER}/api/iac/v1/plan`;
    const proof = await createDpopProof({
      method: "POST",
      url: endpoint,
      privateJwk: key.privateJwk,
      publicJwk: key.publicJwk,
    });
    const proxiedRequest = new Request("http://localhost:3000/api/iac/v1/plan", {
      method: "POST",
    });

    expect(canonicalIacRequestUrl(proxiedRequest)).toBe(endpoint);
    await expect(
      verifyStrictDpop(proof, {
        method: proxiedRequest.method,
        url: canonicalIacRequestUrl(proxiedRequest),
        replay: "disabled",
      }),
    ).resolves.toMatchObject({ publicJwk: key.publicJwk });
  });
});

describe("IaC machine token signing key", () => {
  it("verifies an issued token with the environment public key and exact kid", async () => {
    const key = await generateEs256KeyPair();
    process.env.WELDALL_SIGNING_KID = "iac-signing-key";
    process.env.WELDALL_SIGNING_PRIVATE_JWK = JSON.stringify(key.privateJwk);
    process.env.WELDALL_SIGNING_PUBLIC_JWK = JSON.stringify(key.publicJwk);
    const now = Math.floor(Date.now() / 1000);
    const token = await signWeldallJwt(
      {
        iss: WELDALL_ISSUER,
        sub: "machine",
        aud: WELDALL_RESOURCE,
        iat: now,
        exp: now + 300,
        jti: crypto.randomUUID(),
        identity_type: "machine",
      },
      MACHINE_TOKEN_TYP,
    );
    expect(decodeProtectedHeader(token)).toMatchObject({ kid: "iac-signing-key", alg: "ES256" });
    await expect(verifyWeldallMachineToken(token)).resolves.toMatchObject({ sub: "machine" });

    process.env.WELDALL_SIGNING_KID = "different-kid";
    await expect(verifyWeldallMachineToken(token)).rejects.toThrow(/header/);
  });
});
