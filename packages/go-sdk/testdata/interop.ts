// Node side of the Go SDK interop tests. Run from the repository root:
//   pnpm --silent exec tsx packages/go-sdk/testdata/interop.ts <mode>
// Input (when a mode takes any) is JSON on stdin; output is JSON on stdout.
import { readFileSync } from "node:fs";
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import {
  createDpopProof,
  generateEs256KeyPair,
  issueAccessToken,
  issueIdJag,
  normalizeHtu,
  signEs256,
  verifyAccessToken,
  verifyEs256,
  verifyStrictDpop,
} from "../../sdk/src/index.ts";

const issuer = "https://interop.example";
const resource = "https://interop.example/api";
const clientId = "interop-client";
const url = "https://INTEROP.example:443/api/a//../items?ignored=yes";

const stdin = () => JSON.parse(readFileSync(0, "utf8")) as Record<string, any>;
const write = (value: unknown) => process.stdout.write(JSON.stringify(value));

const mode = process.argv[2];
if (mode === "generate") {
  const signing = await generateEs256KeyPair();
  const device = await generateEs256KeyPair();
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await issueAccessToken({
    issuer,
    subject: "interop-user",
    email: "interop@example.com",
    resource,
    clientId,
    scopes: ["interop:read"],
    jkt: device.jkt,
    kid: "node-signing",
    privateJwk: signing.privateJwk,
    now,
  });
  const genericJwt = await signEs256(
    { iss: issuer, aud: resource, iat: now, exp: now + 300, source: "node" },
    { kid: "node-signing", privateJwk: signing.privateJwk },
  );
  const proof = await createDpopProof({
    ...device,
    method: "GET",
    url,
    accessToken,
    now,
    jti: "node-proof",
  });
  write({
    signingPublicJwk: signing.publicJwk,
    devicePublicJwk: device.publicJwk,
    deviceJkt: device.jkt,
    accessToken,
    genericJwt,
    proof,
  });
} else if (mode === "normalize") {
  const { urls } = stdin() as { urls: string[] };
  write({
    urls: urls.map((value) => {
      try {
        return normalizeHtu(value);
      } catch {
        return null;
      }
    }),
  });
} else if (mode === "href") {
  const { urls } = stdin() as { urls: string[] };
  write({
    urls: urls.map((value) => {
      try {
        return new URL(value).href;
      } catch {
        return null;
      }
    }),
  });
} else if (mode === "verify") {
  const input = stdin();
  const generic = await verifyEs256(input.genericJwt, {
    issuer,
    audience: resource,
    kid: "go-signing",
    publicJwk: input.signingPublicJwk,
  });
  if (generic.source !== "go") throw new Error("Go generic JWT claims mismatch");
  const access = await verifyAccessToken(input.accessToken, {
    issuer,
    resource,
    clientId,
    kid: "go-signing",
    publicJwk: input.signingPublicJwk,
    requiredScopes: ["interop:read"],
  });
  if (access.sub !== "interop-user" || access.scope !== "interop:read")
    throw new Error("Go access token claims mismatch");
  const proof = await verifyStrictDpop(input.proof, {
    method: "GET",
    url,
    replay: "disabled",
    accessToken: input.accessToken,
    expectedJkt: input.deviceJkt,
  });
  if ((await calculateJwkThumbprint(input.devicePublicJwk, "sha256")) !== input.deviceJkt)
    throw new Error("Go JWK thumbprint mismatch");
  if (proof.jkt !== input.deviceJkt) throw new Error("Go DPoP proof key mismatch");
  write({ ok: true });
} else if (mode === "verify-machine") {
  // Checks a machine-client token request the way the issuer would: the RFC
  // 7523 client assertion against the registered key, and the DPoP proof
  // against the token endpoint (no access token bound).
  const input = stdin();
  const header = decodeProtectedHeader(input.assertion);
  if (header.alg !== "ES256" || header.typ !== "JWT" || header.kid !== input.kid)
    throw new Error("machine assertion header mismatch");
  const { payload } = await jwtVerify(input.assertion, await importJWK(input.publicJwk, "ES256"), {
    algorithms: ["ES256"],
    issuer: input.clientId,
    subject: input.clientId,
    audience: input.tokenEndpoint,
    requiredClaims: ["iat", "exp", "jti"],
  });
  if ((payload.exp as number) - (payload.iat as number) !== 60)
    throw new Error("machine assertion lifetime mismatch");
  if (Object.keys(payload).sort().join(",") !== "aud,exp,iat,iss,jti,sub")
    throw new Error("machine assertion carries unexpected claims");
  const proof = await verifyStrictDpop(input.proof, {
    method: "POST",
    url: input.tokenEndpoint,
    replay: "disabled",
    expectedJkt: await calculateJwkThumbprint(input.publicJwk, "sha256"),
  });
  write({ ok: true, jkt: proof.jkt });
} else if (mode === "harness") {
  // Drives a running Go resource over real HTTP the way Weldall and the CLI
  // would, using only the official SDK, and records every exchange. The Go
  // test asserts the pinned results.
  const input = stdin();
  const { host, origin, resource, clientId, weldallKid, weldallPrivateJwk } = input;
  const device = await generateEs256KeyPair();
  const log: Record<string, unknown>[] = [];
  const call = async (name: string, url: string, init: RequestInit = {}) => {
    const response = await fetch(url, init);
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    const headers: Record<string, string> = {};
    for (const key of ["content-type", "cache-control", "www-authenticate"]) {
      const value = response.headers.get(key);
      if (value !== null) headers[key] = value;
    }
    log.push({ name, method: init.method ?? "GET", url, status: response.status, headers, body });
    return body as Record<string, any>;
  };
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/api",
    "/.well-known/jwks.json",
  ])
    await call(path, `${origin}${path}`);

  const now = Math.floor(Date.now() / 1000);
  const skillsAssertion = await signEs256(
    {
      iss: host,
      sub: host,
      aud: `${origin}/.well-known/weldall-skills`,
      resource,
      purpose: "skills:read",
      iat: now,
      exp: now + 60,
      jti: `skills-${now}`,
    },
    { kid: weldallKid, privateJwk: weldallPrivateJwk, typ: "weldall-skills+jwt" },
  );
  await call("skills", `${origin}/.well-known/weldall-skills`, {
    headers: { authorization: `Bearer ${skillsAssertion}` },
  });

  const jag = await issueIdJag({
    issuer: host,
    subject: "harness-user",
    email: "harness@example.com",
    audience: origin,
    clientId,
    resource,
    scopes: ["expenses:read"],
    jkt: device.jkt,
    kid: weldallKid,
    privateJwk: weldallPrivateJwk,
  });
  const tokenProof = await createDpopProof({
    ...device,
    method: "POST",
    url: `${origin}/oauth/token`,
  });
  const token = await call("token", `${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", dpop: tokenProof },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-dpop",
      assertion: jag,
    }),
  });
  const accessToken = token.access_token as string;

  // The issued token must verify in Node against the key the Go JWKS serves.
  const jwks = log.find((entry) => entry.name === "/.well-known/jwks.json")!.body as {
    keys: { kid: string }[];
  };
  const verified = await verifyAccessToken(accessToken, {
    issuer: origin,
    resource,
    clientId,
    kid: jwks.keys[0]!.kid,
    publicJwk: jwks.keys[0]! as never,
    requiredScopes: ["expenses:read"],
  });

  const protectedCall = async (name: string, path: string, proof?: string) => {
    const url = `${origin}${path}`;
    const dpop = proof ?? (await createDpopProof({ ...device, method: "GET", url, accessToken }));
    await call(name, url, { headers: { authorization: `DPoP ${accessToken}`, dpop } });
    return dpop;
  };
  const used = await protectedCall("protected with scope", "/api/expenses");
  await protectedCall("protected missing scope", "/api/admin");
  await protectedCall("replayed proof", "/api/expenses", used);
  await call("no authorization", `${origin}/api/expenses`);
  write({ log, verifiedSubject: verified.sub, deviceJkt: device.jkt });
} else {
  throw new Error("expected generate, normalize, href, verify, verify-machine or harness");
}
