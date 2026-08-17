import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  calculateJwkThumbprint,
  compactVerify,
  decodeProtectedHeader,
  importJWK,
  type JWK,
} from "jose";

const browserOrigin = "http://127.0.0.1:4178";
const cors = {
  "access-control-allow-origin": browserOrigin,
  "access-control-allow-headers": "Authorization, DPoP, Content-Type",
  "access-control-allow-methods": "GET, POST",
  "access-control-expose-headers": "WWW-Authenticate, DPoP-Nonce",
};
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: unknown) =>
  `${encoded({ alg: "ES256", typ: "at+jwt" })}.${encoded(payload)}.${"a".repeat(86)}`;
const ath = (token: string) => createHash("sha256").update(token, "ascii").digest("base64url");

function exactForm(request: { postData(): string | null }, expected: Record<string, string>) {
  const form = new URLSearchParams(request.postData() ?? "");
  expect([...form.keys()].sort()).toEqual(Object.keys(expected).sort());
  for (const [key, value] of Object.entries(expected)) expect(form.get(key)).toBe(value);
}

type ProtocolState = {
  devicePolls: number;
  refreshes: number;
  exchanges: number;
  downstreamExchanges: number;
  protectedCalls: number;
  statusCalls: number;
  revocations: number;
  replayCount: number;
  currentRefresh: string;
  statusError?: "origin" | "revoked" | "expired";
};

async function installProtocolServer(
  page: Page,
  pendingResponses = 2,
  pollingInterval = 0,
): Promise<ProtocolState> {
  const state: ProtocolState = {
    devicePolls: 0,
    refreshes: 0,
    exchanges: 0,
    downstreamExchanges: 0,
    protectedCalls: 0,
    statusCalls: 0,
    revocations: 0,
    replayCount: 0,
    currentRefresh: "",
  };
  const replay = new Set<string>();
  let jkt = "";
  let lastWeldallAccess = "";
  let lastAssertion = "";
  const deviceSecret = "device-secret";
  const issueAssertion = () =>
    jwt({
      iss: "https://weldall.example",
      sub: "subject-1",
      aud: "https://resource.example",
      client_id: "resource-client",
      resource: "https://resource.example/api",
      cnf: { jkt },
      scope: "resource:read",
      exp: Math.floor(Date.now() / 1000) + 300,
    });

  async function verifyDpop(
    proof: string | undefined,
    method: string,
    url: string,
    accessToken?: string,
  ) {
    expect(proof, "DPoP proof is required").toBeTruthy();
    const header = decodeProtectedHeader(proof!);
    expect(header).toMatchObject({ alg: "ES256", typ: "dpop+jwt" });
    expect(header.jwk).toBeTruthy();
    expect((header.jwk as JWK).d).toBeUndefined();
    const verified = await compactVerify(proof!, await importJWK(header.jwk as JWK, "ES256"));
    const payload = JSON.parse(new TextDecoder().decode(verified.payload)) as Record<
      string,
      unknown
    >;
    expect(payload.htm).toBe(method.toUpperCase());
    expect(payload.htu).toBe(url);
    expect(typeof payload.iat).toBe("number");
    expect(Math.abs((payload.iat as number) - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(
      60,
    );
    expect(typeof payload.jti).toBe("string");
    if (replay.has(payload.jti as string)) throw new Error("replayed DPoP proof");
    replay.add(payload.jti as string);
    state.replayCount = replay.size;
    expect(payload.ath).toBe(accessToken ? ath(accessToken) : undefined);
    const proofJkt = await calculateJwkThumbprint(header.jwk as JWK, "sha256");
    if (jkt) expect(proofJkt).toBe(jkt);
    else jkt = proofJkt;
  }

  const access = () => {
    lastWeldallAccess = jwt({
      iss: "https://weldall.example",
      sub: "subject-1",
      aud: "https://weldall.example/api",
      client_id: "weldall-browser:resource",
      cnf: { jkt },
      weldall_connection_id: "connection-1",
      weldall_connection_origin: "https://resource.example",
      weldall_connection_resource: "https://resource.example/api",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    return lastWeldallAccess;
  };

  await page.context().route("https://weldall.example/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return route.fulfill({
        headers: cors,
        json: {
          issuer: "https://weldall.example",
          token_endpoint: "https://weldall.example/api/auth/oauth2/token",
          device_authorization_endpoint:
            "https://weldall.example/api/auth/oauth2/device_authorization",
          grant_types_supported: [DEVICE_GRANT, "refresh_token"],
          weldall_browser_connections: {
            current_status_endpoint: "https://weldall.example/api/me/browser-connections/current",
            current_revoke_endpoint:
              "https://weldall.example/api/me/browser-connections/current/revoke",
            resource_registry_endpoint: "https://weldall.example/api/me/scopes",
            resource_discovery_endpoint: "https://weldall.example/api/browser/resources/current",
          },
        },
      });
    if (url.pathname === "/api/browser/resources/current") {
      expect(url.searchParams.get("resource")).toBe("https://resource.example/api");
      return route.fulfill({
        headers: cors,
        json: {
          key: "resource",
          name: "Resource",
          resourceIdentifier: "https://resource.example/api",
          authorizationServer: "https://resource.example",
          downstreamClientId: "resource-client",
          requestPrefixes: ["https://resource.example/api/"],
          supportedScopes: ["resource:read"],
          grantedScopes: [],
          browserClientId: "weldall-browser:resource",
        },
      });
    }
    if (url.pathname === "/api/auth/oauth2/device_authorization") {
      await verifyDpop(request.headers().dpop, "POST", request.url());
      exactForm(request, {
        client_id: "weldall-browser:resource",
        resource: "https://resource.example/api",
      });
      return route.fulfill({
        headers: cors,
        json: {
          device_code: deviceSecret,
          user_code: "ABCD-EFGH",
          verification_uri: "https://weldall.example/connect",
          expires_in: 60,
          interval: pollingInterval,
        },
      });
    }
    if (url.pathname === "/api/auth/oauth2/token") {
      const form = new URLSearchParams(request.postData() ?? "");
      const grant = form.get("grant_type");
      await verifyDpop(request.headers().dpop, "POST", request.url());
      if (grant === DEVICE_GRANT) {
        exactForm(request, {
          grant_type: DEVICE_GRANT,
          client_id: "weldall-browser:resource",
          device_code: deviceSecret,
        });
        state.devicePolls += 1;
        if (state.devicePolls <= pendingResponses)
          return route.fulfill({
            status: 400,
            headers: cors,
            json: { error: state.devicePolls === 1 ? "authorization_pending" : "slow_down" },
          });
        state.currentRefresh = "refresh-1";
        return route.fulfill({
          headers: cors,
          json: {
            access_token: access(),
            refresh_token: state.currentRefresh,
            token_type: "DPoP",
            expires_in: 300,
          },
        });
      }
      if (grant === "refresh_token") {
        exactForm(request, {
          grant_type: "refresh_token",
          client_id: "weldall-browser:resource",
          refresh_token: state.currentRefresh,
        });
        state.refreshes += 1;
        state.currentRefresh = `refresh-${state.refreshes + 1}`;
        return route.fulfill({
          headers: cors,
          json: {
            access_token: access(),
            refresh_token: state.currentRefresh,
            token_type: "DPoP",
            expires_in: 300,
          },
        });
      }
      expect(grant).toBe(EXCHANGE_GRANT);
      exactForm(request, {
        grant_type: EXCHANGE_GRANT,
        requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
        subject_token_type: "urn:ietf:params:oauth:token-type:refresh_token",
        subject_token: state.currentRefresh,
        client_id: "weldall-browser:resource",
        resource: "https://resource.example/api",
        audience: "https://resource.example",
        scope: "resource:read",
      });
      state.exchanges += 1;
      lastAssertion = issueAssertion();
      return route.fulfill({
        headers: cors,
        json: {
          access_token: lastAssertion,
          issued_token_type: "urn:ietf:params:oauth:token-type:id-jag",
        },
      });
    }
    if (url.pathname === "/api/me/scopes") {
      await verifyDpop(request.headers().dpop, "GET", request.url(), lastWeldallAccess);
      expect(request.headers().authorization).toBe(`DPoP ${lastWeldallAccess}`);
      return route.fulfill({
        headers: cors,
        json: [
          {
            key: "resource",
            name: "Resource",
            resourceIdentifier: "https://resource.example/api",
            authorizationServer: "https://resource.example",
            downstreamClientId: "resource-client",
            requestPrefixes: ["https://resource.example/api/"],
            supportedScopes: ["resource:read"],
            grantedScopes: ["resource:read"],
          },
        ],
      });
    }
    if (url.pathname === "/api/me/browser-connections/current") {
      await verifyDpop(request.headers().dpop, "GET", request.url(), lastWeldallAccess);
      expect(request.headers().authorization).toBe(`DPoP ${lastWeldallAccess}`);
      state.statusCalls += 1;
      if (state.statusError === "origin")
        return route.fulfill({
          status: 403,
          headers: cors,
          json: { error: "browser_connection_origin_changed" },
        });
      if (state.statusError === "revoked")
        return route.fulfill({
          status: 401,
          headers: cors,
          json: { error: "browser_connection_revoked" },
        });
      if (state.statusError === "expired")
        return route.fulfill({ status: 401, headers: cors, json: { error: "invalid_token" } });
      return route.fulfill({
        headers: cors,
        json: {
          id: "connection-1",
          state: "active",
          origin: "https://resource.example",
          resource: "https://resource.example/api",
          subject: "subject-1",
        },
      });
    }
    if (url.pathname.endsWith("/revoke")) {
      await verifyDpop(request.headers().dpop, "POST", request.url(), lastWeldallAccess);
      expect(request.headers().authorization).toBe(`DPoP ${lastWeldallAccess}`);
      state.revocations += 1;
      if (state.revocations === 1)
        return route.fulfill({
          status: 503,
          headers: cors,
          json: { error: "temporarily_unavailable" },
        });
      return route.fulfill({
        headers: cors,
        json: { revoked: true, connectionId: "connection-1" },
      });
    }
    throw new Error(`unexpected Weldall request ${request.method()} ${request.url()}`);
  });

  await page.context().route("https://resource.example/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === "/oauth/token") {
      await verifyDpop(request.headers().dpop, "POST", request.url());
      exactForm(request, {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-dpop",
        assertion: lastAssertion,
      });
      state.downstreamExchanges += 1;
      return route.fulfill({
        headers: cors,
        json: { access_token: "downstream-access", token_type: "DPoP", expires_in: 300 },
      });
    }
    if (url.pathname === "/api/data") {
      await verifyDpop(request.headers().dpop, "GET", request.url(), "downstream-access");
      expect(request.headers().authorization).toBe("DPoP downstream-access");
      state.protectedCalls += 1;
      return route.fulfill({ headers: cors, status: 200, json: { ok: true } });
    }
    throw new Error(`unexpected resource request ${request.method()} ${request.url()}`);
  });
  return state;
}

test("packed production bundle performs real WebCrypto, IndexedDB and DPoP operations", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#result")).toHaveText("ready");
  const result = await page.evaluate(() => window.weldallProbe());
  expect(result).toMatchObject({
    support: { supported: true, missingFeatures: [] },
    privateExtractable: false,
    reloadedExtractable: false,
    reloadedSignatureBytes: 64,
    proofParts: 3,
  });
  expect(result.jkt).toMatch(/^[A-Za-z0-9_-]{43}$/u);
});

test("packed client validates the complete protocol, rotates, requests and disconnects", async ({
  page,
}) => {
  const state = await installProtocolServer(page);
  await page.goto("/");
  const result = await page.evaluate(() => window.weldallConnectionProbe());
  expect(result).toMatchObject({
    before: { state: "disconnected", verified: "local" },
    userCode: "ABCD-EFGH",
    connected: { state: "connected", verified: "remote", connectionId: "connection-1" },
    local: { state: "connected", verified: "local" },
    remote: { state: "connected", verified: "remote" },
    resourceStatus: 200,
    resourceBody: { ok: true },
    disconnectFailure: expect.stringContaining("could not revoke"),
    afterFailedDisconnect: { state: "connected", verified: "local" },
    after: { state: "disconnected", verified: "local" },
  });
  expect(state).toMatchObject({
    devicePolls: 3,
    refreshes: 2,
    exchanges: 1,
    downstreamExchanges: 1,
    protectedCalls: 1,
    statusCalls: 1,
    revocations: 2,
  });
  expect(state.replayCount).toBeGreaterThanOrEqual(10);
});

test("two real pages serialize shared IndexedDB refresh rotation with navigator.locks", async ({
  page,
  context,
}) => {
  const state = await installProtocolServer(page, 0);
  const second = await context.newPage();
  await page.goto("/");
  await second.goto("/");
  const databaseName = `shared-${Date.now()}`;
  await expect(
    page.evaluate((name) => window.weldallSharedConnect(name), databaseName),
  ).resolves.toMatchObject({ state: "connected" });
  const [firstStatus, secondStatus] = await Promise.all([
    page.evaluate((name) => window.weldallSharedRemote(name), databaseName),
    second.evaluate((name) => window.weldallSharedRemote(name), databaseName),
  ]);
  expect(firstStatus).toMatchObject({ state: "connected", verified: "remote" });
  expect(secondStatus).toMatchObject({ state: "connected", verified: "remote" });
  expect(state.devicePolls).toBe(1);
  expect(state.refreshes).toBe(2);
  expect(state.currentRefresh).toBe("refresh-3");
});

test("local recovery clears a pending pairing without waiting for its poll interval", async ({
  page,
}) => {
  await installProtocolServer(page, 100, 30);
  await page.goto("/");
  const result = await page.evaluate(
    (name) => window.weldallCancelPending(name),
    `cancel-${Date.now()}`,
  );
  expect(result).toMatchObject({
    status: { state: "disconnected", verified: "local" },
    rejection: expect.stringContaining("cleared"),
  });
  expect(result.elapsedMs).toBeLessThan(2_000);
});

for (const [serverError, reason] of [
  ["origin", "origin-changed"],
  ["revoked", "revoked"],
  ["expired", "expired"],
] as const) {
  test(`maps stable remote status error ${serverError}`, async ({ page }) => {
    const state = await installProtocolServer(page, 0);
    await page.goto("/");
    const databaseName = `status-${serverError}-${Date.now()}`;
    await page.evaluate((name) => window.weldallSharedConnect(name), databaseName);
    state.statusError = serverError;
    await expect(
      page.evaluate((name) => window.weldallSharedRemote(name), databaseName),
    ).resolves.toMatchObject({ state: "invalid", verified: "remote", reason });
  });
}
