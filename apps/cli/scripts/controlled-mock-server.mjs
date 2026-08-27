import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  ID_JAG_TOKEN_TYPE,
  JWT_DPOP_GRANT,
  REFRESH_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT,
  generateEs256KeyPair,
  issueAccessToken,
  issueIdJag,
  signEs256,
  verifyStrictDpop,
} from "@weldall/sdk";
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify } from "jose";

const ORIGINAL_ORIGIN_HEADER = "x-weldall-test-original-origin";
const CLIENT_ID = "weldall-cli";
const SUBJECT = "artifact-user";
const EMAIL = "artifact.user@example.com";
const MACHINE_CLIENT_ID = "artifact-iac-machine";
const MACHINE_KID = "artifact-machine-key";
const ISSUER_KID = "artifact-issuer-key";
const INSTALLATION_ID = "11111111-2222-4333-8444-555555555555";
const DOWNLOAD_BYTES = Buffer.from([0, 255, 1, 128, 13, 10, 42, 200]);
const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

const readBody = async (request) => {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    assert.ok(length <= 1024 * 1024, "mock request body exceeded limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const json = (response, value, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const form = (body) => new URLSearchParams(body.toString("utf8"));
const one = (params, name) => {
  const values = params.getAll(name);
  assert.equal(values.length, 1, `expected one ${name}`);
  assert.ok(values[0], `expected non-empty ${name}`);
  return values[0];
};

export async function startControlledMockServer() {
  const id = randomUUID().replaceAll("-", "");
  const issuer = `https://issuer-${id}.example`;
  const resourceAuthorizationServer = `https://resource-as-${id}.example`;
  const resource = `${resourceAuthorizationServer}/api`;
  const downstreamClientId = "weldall-cli-artifact-resource";
  const issuerKey = await generateEs256KeyPair();
  const machineKey = await generateEs256KeyPair();
  const requests = [];
  const errors = [];
  const accessKeys = new Map();
  const downstreamKeys = new Map();
  let authorization;
  let refreshToken = "artifact-refresh-0";
  let rotation = 0;
  let revoked = 0;
  let uploadedBytes;
  let refreshDelay;
  let downloadDelay;

  const originalUrl = (request) => {
    const origin = request.headers[ORIGINAL_ORIGIN_HEADER];
    assert.equal(typeof origin, "string", "missing test bridge origin header");
    assert.ok(
      origin === issuer || origin === resourceAuthorizationServer,
      "unexpected source origin",
    );
    return new URL(request.url ?? "/", `${origin}/`);
  };

  const verifyDpop = async (request, url, accessToken) => {
    const proof = request.headers.dpop;
    assert.equal(typeof proof, "string", "missing DPoP header");
    const jwk = decodeProtectedHeader(proof).jwk;
    assert.ok(jwk, "missing DPoP public JWK");
    const jkt = await calculateJwkThumbprint(jwk, "sha256");
    await verifyStrictDpop(proof, {
      method: request.method,
      url: url.toString(),
      replay: "disabled",
      ...(accessToken === undefined ? {} : { accessToken }),
      ...(accessToken === undefined
        ? {}
        : { expectedJkt: accessKeys.get(accessToken) ?? downstreamKeys.get(accessToken) }),
    });
    return { jwk, jkt };
  };

  const authenticate = async (request, url, downstream = false) => {
    const authorizationHeader = request.headers.authorization;
    assert.equal(typeof authorizationHeader, "string", "missing authorization header");
    assert.match(authorizationHeader, /^DPoP /);
    const token = authorizationHeader.slice(5);
    assert.ok((downstream ? downstreamKeys : accessKeys).has(token), "unknown access token");
    await verifyDpop(request, url, token);
    return token;
  };

  const accessToken = async (jkt, clientId = CLIENT_ID, scopes = ["files:read", "files:write"]) => {
    const token = await issueAccessToken({
      issuer,
      subject: SUBJECT,
      email: EMAIL,
      resource: `${issuer}/api`,
      clientId,
      scopes,
      jkt,
      kid: ISSUER_KID,
      privateJwk: issuerKey.privateJwk,
    });
    accessKeys.set(token, jkt);
    return token;
  };

  const oauthMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/api/auth/oauth2/authorize`,
    token_endpoint: `${issuer}/api/auth/oauth2/token`,
    revocation_endpoint: `${issuer}/api/auth/oauth2/revoke`,
    jwks_uri: `${issuer}/api/oauth/jwks`,
    scopes_supported: ["openid", "profile", "email", "offline_access", "weldall:scopes"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
    code_challenge_methods_supported: ["S256"],
    dpop_signing_alg_values_supported: ["ES256"],
    authorization_response_iss_parameter_supported: true,
    weldall_iac: {
      endpoint: `${issuer}/api/iac/v1`,
      installationId: INSTALLATION_ID,
      scope: "weldall:iac",
    },
  };

  const server = createServer(async (request, response) => {
    try {
      const url = originalUrl(request);
      requests.push(`${request.method} ${url.origin}${url.pathname}`);
      if (
        request.method === "GET" &&
        url.origin === issuer &&
        url.pathname === "/.well-known/oauth-authorization-server"
      ) {
        assert.equal(request.headers.accept, "application/json");
        return json(response, oauthMetadata);
      }
      if (
        request.method === "GET" &&
        url.origin === issuer &&
        url.pathname === "/.well-known/oauth-protected-resource/api"
      ) {
        return json(response, { resource: `${issuer}/api`, authorization_servers: [issuer] });
      }
      if (request.method === "GET" && url.origin === issuer && url.pathname === "/api/oauth/jwks") {
        return json(response, {
          keys: [{ ...issuerKey.publicJwk, kid: ISSUER_KID, alg: "ES256", use: "sig" }],
        });
      }
      if (
        request.method === "POST" &&
        url.origin === issuer &&
        url.pathname === "/api/auth/oauth2/token"
      ) {
        assert.match(request.headers["content-type"] ?? "", /^application\/x-www-form-urlencoded/);
        const body = form(await readBody(request));
        const grantType = one(body, "grant_type");
        if (grantType === "authorization_code") {
          assert.ok(authorization, "authorization URL was not registered");
          assert.equal(one(body, "client_id"), CLIENT_ID);
          assert.equal(one(body, "code"), authorization.code);
          assert.equal(one(body, "redirect_uri"), authorization.redirectUri);
          const verifier = one(body, "code_verifier");
          assert.ok(verifier.length >= 43);
          assert.equal(
            createHash("sha256").update(verifier).digest("base64url"),
            authorization.codeChallenge,
            "PKCE verifier must match the authorization code challenge",
          );
          const device = await verifyDpop(request, url);
          assert.equal(device.jkt, authorization.jkt);
          const access = await accessToken(device.jkt);
          const now = Math.floor(Date.now() / 1000);
          const idToken = await signEs256(
            {
              iss: issuer,
              sub: SUBJECT,
              aud: CLIENT_ID,
              nonce: authorization.nonce,
              iat: now,
              exp: now + 300,
            },
            { kid: ISSUER_KID, privateJwk: issuerKey.privateJwk },
          );
          return json(response, {
            token_type: "DPoP",
            access_token: access,
            refresh_token: refreshToken,
            id_token: idToken,
          });
        }
        if (grantType === "refresh_token") {
          assert.equal(one(body, "client_id"), CLIENT_ID);
          assert.equal(one(body, "refresh_token"), refreshToken);
          const device = await verifyDpop(request, url);
          assert.equal(device.jkt, authorization?.jkt, "refresh DPoP key changed");
          if (refreshDelay) {
            const delay = refreshDelay;
            refreshDelay = undefined;
            delay.enter();
            await delay.wait;
          }
          refreshToken = `artifact-refresh-${++rotation}`;
          return json(response, {
            token_type: "DPoP",
            access_token: await accessToken(device.jkt),
            refresh_token: refreshToken,
          });
        }
        if (grantType === TOKEN_EXCHANGE_GRANT) {
          assert.equal(one(body, "client_id"), CLIENT_ID);
          assert.equal(one(body, "subject_token"), refreshToken);
          assert.equal(one(body, "subject_token_type"), REFRESH_TOKEN_TYPE);
          assert.equal(one(body, "requested_token_type"), ID_JAG_TOKEN_TYPE);
          assert.equal(one(body, "audience"), resourceAuthorizationServer);
          assert.equal(one(body, "resource"), resource);
          const scopes = one(body, "scope").split(" ");
          const device = await verifyDpop(request, url);
          assert.equal(device.jkt, authorization?.jkt, "token-exchange DPoP key changed");
          const assertion = await issueIdJag({
            issuer,
            subject: SUBJECT,
            email: EMAIL,
            audience: resourceAuthorizationServer,
            clientId: downstreamClientId,
            resource,
            scopes,
            jkt: device.jkt,
            kid: ISSUER_KID,
            privateJwk: issuerKey.privateJwk,
          });
          return json(response, {
            access_token: assertion,
            issued_token_type: ID_JAG_TOKEN_TYPE,
            token_type: "N_A",
            expires_in: 300,
            scope: [...new Set(scopes)].sort().join(" "),
          });
        }
        if (grantType === "client_credentials") {
          assert.equal(one(body, "client_id"), MACHINE_CLIENT_ID);
          assert.equal(one(body, "client_assertion_type"), CLIENT_ASSERTION_TYPE);
          assert.equal(one(body, "scope"), "weldall:iac");
          assert.equal(one(body, "resource"), `${issuer}/api`);
          const device = await verifyDpop(request, url);
          assert.equal(device.jkt, machineKey.jkt);
          const assertion = one(body, "client_assertion");
          const verified = await jwtVerify(
            assertion,
            await importJWK(machineKey.publicJwk, "ES256"),
            {
              algorithms: ["ES256"],
              issuer: MACHINE_CLIENT_ID,
              subject: MACHINE_CLIENT_ID,
              audience: `${issuer}/api/auth/oauth2/token`,
            },
          );
          assert.equal(verified.protectedHeader.kid, MACHINE_KID);
          const token = `machine-access-${randomUUID()}`;
          accessKeys.set(token, machineKey.jkt);
          return json(response, {
            access_token: token,
            token_type: "DPoP",
            expires_in: 300,
            scope: "weldall:iac",
          });
        }
        throw new Error(`unsupported grant type ${grantType}`);
      }
      if (
        request.method === "POST" &&
        url.origin === issuer &&
        url.pathname === "/api/auth/oauth2/revoke"
      ) {
        const body = form(await readBody(request));
        assert.equal(one(body, "token"), refreshToken);
        assert.equal(one(body, "client_id"), CLIENT_ID);
        const device = await verifyDpop(request, url);
        assert.equal(device.jkt, authorization?.jkt, "revocation DPoP key changed");
        revoked += 1;
        response.writeHead(200).end();
        return;
      }
      if (
        request.method === "GET" &&
        url.origin === issuer &&
        url.pathname === "/api/auth/oauth2/userinfo"
      ) {
        await authenticate(request, url);
        return json(response, {
          sub: SUBJECT,
          name: "Artifact User",
          email: EMAIL,
          email_verified: true,
        });
      }
      if (request.method === "GET" && url.origin === issuer && url.pathname === "/api/me/grants") {
        await authenticate(request, url);
        return json(response, ["files:read", "files:write"]);
      }
      if (request.method === "GET" && url.origin === issuer && url.pathname === "/api/me/scopes") {
        await authenticate(request, url);
        return json(response, [
          {
            key: "files",
            name: "Artifact Files",
            resourceIdentifier: resource,
            authorizationServer: resourceAuthorizationServer,
            downstreamClientId,
            requestPrefixes: [`${resourceAuthorizationServer}/api`],
            supportedScopes: ["files:read", "files:write"],
            grantedScopes: ["files:read", "files:write"],
          },
        ]);
      }
      if (request.method === "GET" && url.origin === issuer && url.pathname === "/api/me/skills") {
        await authenticate(request, url);
        return json(response, {
          items: [
            {
              slug: "files.transfer",
              title: "Transfer artifact files",
              requiredScopes: ["files:read"],
              visibility: "DEFAULT",
              available: true,
              missingScopes: [],
              updatedAt: "2026-01-01T00:00:00.000Z",
              meta: { tags: ["artifact", "files"], owner: "Platform" },
              source: { type: "resource", key: "files", name: "Artifact Files" },
            },
          ],
          warnings: [],
        });
      }
      if (
        request.method === "GET" &&
        url.origin === issuer &&
        url.pathname === "/api/me/skills/files.transfer"
      ) {
        await authenticate(request, url);
        return json(response, {
          slug: "files.transfer",
          title: "Transfer artifact files",
          requiredScopes: ["files:read"],
          visibility: "DEFAULT",
          available: true,
          missingScopes: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
          meta: { tags: ["artifact", "files"], owner: "Platform" },
          source: { type: "resource", key: "files", name: "Artifact Files" },
          content: "Transfer files safely.",
          document: "# Transfer artifact files\n\nTransfer files safely.\n",
        });
      }
      if (
        request.method === "POST" &&
        url.origin === resourceAuthorizationServer &&
        url.pathname === "/oauth/token"
      ) {
        const body = form(await readBody(request));
        assert.equal(one(body, "grant_type"), JWT_DPOP_GRANT);
        const assertion = one(body, "assertion");
        const device = await verifyDpop(request, url);
        const verified = await jwtVerify(assertion, await importJWK(issuerKey.publicJwk, "ES256"), {
          algorithms: ["ES256"],
          issuer,
          audience: resourceAuthorizationServer,
          typ: "oauth-id-jag+jwt",
        });
        assert.equal(verified.protectedHeader.kid, ISSUER_KID);
        assert.equal(verified.payload.client_id, downstreamClientId);
        assert.equal(verified.payload.resource, resource);
        assert.equal(verified.payload.cnf?.jkt, device.jkt);
        const token = `downstream-access-${randomUUID()}`;
        downstreamKeys.set(token, device.jkt);
        return json(response, { access_token: token, token_type: "DPoP", expires_in: 300 });
      }
      if (url.origin === resourceAuthorizationServer && url.pathname === "/api/files/upload") {
        assert.equal(request.method, "PUT");
        await authenticate(request, url, true);
        uploadedBytes = await readBody(request);
        return json(response, { uploaded: uploadedBytes.length });
      }
      if (url.origin === resourceAuthorizationServer && url.pathname === "/api/files/pages") {
        assert.equal(request.method, "GET");
        await authenticate(request, url, true);
        assert.equal(url.searchParams.get("limit"), "2");
        const offset = Number(url.searchParams.get("offset"));
        assert.ok([0, 2, 4].includes(offset), "unexpected pagination offset");
        return json(response, { metadata: { total_pages: 3 }, offset });
      }
      if (url.origin === resourceAuthorizationServer && url.pathname === "/api/files/download") {
        assert.equal(request.method, "GET");
        await authenticate(request, url, true);
        response.writeHead(200, { "content-type": "application/octet-stream" });
        if (downloadDelay) {
          const delay = downloadDelay;
          downloadDelay = undefined;
          response.write(Buffer.alloc(64 * 1024, 0x5a));
          delay.enter();
          await delay.wait;
        }
        response.end(DOWNLOAD_BYTES);
        return;
      }
      if (url.origin === issuer && url.pathname === "/api/iac/v1/plan") {
        assert.equal(request.method, "POST");
        await authenticate(request, url);
        const body = JSON.parse((await readBody(request)).toString("utf8"));
        assert.equal(body.manifest.workspace.issuer, issuer);
        return json(response, {
          actions: [
            { action: "create", address: "scope.artifact_read", identity: "artifact:read" },
          ],
          blockers: [],
          revision: 7,
          configDigest: "a".repeat(64),
          digest: "b".repeat(64),
        });
      }
      if (
        url.origin === issuer &&
        /^\/api\/iac\/v1\/workspaces\/[^/]+\/state$/.test(url.pathname)
      ) {
        assert.equal(request.method, "GET");
        await authenticate(request, url);
        const workspaceId = url.pathname.split("/").at(-2);
        return json(response, {
          workspace: { id: workspaceId, name: "Artifact Workspace", revision: 7 },
          objects: [
            {
              address: "scope.artifact_read",
              kind: "scope",
              objectId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              identity: "artifact:read",
              observedVersion: 1,
            },
          ],
        });
      }
      json(response, { error: "not_found" }, 404);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      json(response, { error: "controlled mock request rejected" }, 500);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const destination = `http://127.0.0.1:${address.port}`;

  return {
    issuer,
    resourceAuthorizationServer,
    uploadUrl: `${resourceAuthorizationServer}/api/files/upload`,
    downloadUrl: `${resourceAuthorizationServer}/api/files/download`,
    pagesUrl: `${resourceAuthorizationServer}/api/files/pages`,
    downloadBytes: DOWNLOAD_BYTES,
    machineEnvironment: {
      WELDALL_M2M_CLIENT_ID: MACHINE_CLIENT_ID,
      WELDALL_M2M_KID: MACHINE_KID,
      WELDALL_M2M_PRIVATE_JWK: JSON.stringify(machineKey.privateJwk),
      WELDALL_M2M_PUBLIC_JWK: JSON.stringify(machineKey.publicJwk),
    },
    bridgeEnvironment: JSON.stringify({
      [issuer]: destination,
      [resourceAuthorizationServer]: destination,
    }),
    registerAuthorization(urlValue) {
      const url = new URL(urlValue);
      assert.equal(url.origin, issuer);
      assert.equal(url.pathname, "/api/auth/oauth2/authorize");
      assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("prompt"), "consent");
      assert.equal(
        url.searchParams.get("scope"),
        "openid profile email offline_access weldall:scopes",
      );
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("resource"), `${issuer}/api`);
      const redirectUri = url.searchParams.get("redirect_uri");
      assert.ok(redirectUri && /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri));
      authorization = {
        code: "artifact-authorization-code",
        redirectUri,
        nonce: url.searchParams.get("nonce"),
        jkt: url.searchParams.get("dpop_jkt"),
        codeChallenge: one(url.searchParams, "code_challenge"),
      };
      assert.ok(authorization.nonce && authorization.jkt);
      const callback = new URL(redirectUri);
      callback.searchParams.set("state", one(url.searchParams, "state"));
      callback.searchParams.set("iss", issuer);
      callback.searchParams.set("code", authorization.code);
      return callback.toString();
    },
    armDownloadDelay() {
      assert.equal(downloadDelay, undefined);
      let enter;
      let release;
      const entered = new Promise((resolve) => (enter = resolve));
      const wait = new Promise((resolve) => (release = resolve));
      downloadDelay = { enter, wait };
      return { entered, release };
    },
    armRefreshDelay() {
      assert.equal(refreshDelay, undefined);
      let enter;
      let release;
      const entered = new Promise((resolve) => (enter = resolve));
      const wait = new Promise((resolve) => (release = resolve));
      refreshDelay = { enter, wait };
      return { entered, release };
    },
    get uploadedBytes() {
      return uploadedBytes;
    },
    get rotationCount() {
      return rotation;
    },
    get revokedCount() {
      return revoked;
    },
    requests,
    assertHealthy() {
      assert.deepEqual(errors, [], `controlled mock failures: ${errors.join("; ")}`);
    },
    async close() {
      if (refreshDelay) {
        refreshDelay.release?.();
        refreshDelay = undefined;
      }
      if (downloadDelay) {
        downloadDelay.release?.();
        downloadDelay = undefined;
      }
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
