import { describe, expect, it, vi } from "vitest";
import {
  calculateEffectiveCapabilities,
  listAvailableScopes,
  shouldReconnectAfterRefresh,
  requiredScopes,
  validateSelectedScopes,
  validateConnectorScopeConfig,
} from "../src/server/connectors/scopes";
import { resolveConnectorOperation } from "../src/server/connectors/registry";
import {
  assertConnectionOwner,
  buildConnectionMetadata,
} from "../src/server/connectors/connections";
import { buildUpstreamHeaders } from "../src/server/connectors/execution";
import {
  buildGoogleAuthorizationUrl,
  readBoundedBody,
  revokeGoogleAuthorization,
} from "../src/server/connectors/google";
import {
  parseDesiredState,
  importRequestSchema,
  moveRequestSchema,
} from "../src/server/iac/contracts";
import { createPlan } from "../src/server/iac/planner";

const read = "https://www.googleapis.com/auth/gmail.readonly";
const modify = "https://www.googleapis.com/auth/gmail.modify";
const calendar = "https://www.googleapis.com/auth/calendar.readonly";
const config = {
  key: "google",
  name: "Google",
  type: "google" as const,
  enabled: false,
  envelopeProvider: "LOCAL_ENV" as const,
  clientId: "client",
  enabledApis: ["gmail", "calendar"] as ("gmail" | "calendar")[],
  allowedScopes: [read, modify, calendar],
  defaultScopes: [calendar],
};

describe("managed connector boundaries", () => {
  it("separates requirements, defaults, selection and actual grants", () => {
    expect(
      listAvailableScopes(config)
        .filter((s) => s.required)
        .map((s) => s.id),
    ).toEqual(requiredScopes);
    expect(
      validateSelectedScopes({ config, selected: [...requiredScopes, calendar] }),
    ).not.toContain(read);
    expect(() => validateSelectedScopes({ config, selected: [calendar] })).toThrow("required");
    expect(() =>
      validateSelectedScopes({ config, selected: [...requiredScopes, "tampered"] }),
    ).toThrow();
    expect(() => validateSelectedScopes({ config, selected: requiredScopes })).toThrow(
      "at least one",
    );
    expect(() => validateConnectorScopeConfig({ ...config, defaultScopes: ["unknown"] })).toThrow();
    expect(
      calculateEffectiveCapabilities({ config, selected: [calendar, read], granted: [calendar] }),
    ).toEqual(["calendar.events.read", "calendar.read"]);
    expect(calculateEffectiveCapabilities({ config, selected: [read], granted: [modify] })).toEqual(
      ["gmail.read"],
    );
    expect(
      calculateEffectiveCapabilities({ config, selected: [modify], granted: [modify] }),
    ).toContain("gmail.send");
    expect(
      calculateEffectiveCapabilities({
        config: { ...config, allowedScopes: [read] },
        selected: [modify],
        granted: [modify],
      }),
    ).toEqual(["gmail.read"]);
    const url = new URL(
      buildGoogleAuthorizationUrl({
        clientId: "c",
        redirectUri: "https://weldall.example.com/callback",
        state: "s",
        nonce: "n",
        challenge: "v",
        selected: [...requiredScopes, calendar],
      }),
    );
    expect(url.searchParams.get("scope")).not.toContain("gmail");
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
  });
  it("requires reconnect rather than silently adding capabilities during refresh", () => {
    expect(
      shouldReconnectAfterRefresh({
        config,
        previous: [...requiredScopes, read],
        selected: [...requiredScopes, modify],
        next: [...requiredScopes, modify],
      }),
    ).toBe(true);
    expect(
      shouldReconnectAfterRefresh({
        config,
        previous: [modify],
        selected: [...requiredScopes, modify],
        next: [...requiredScopes, read],
      }),
    ).toBe(false);
    expect(
      shouldReconnectAfterRefresh({
        config,
        previous: [read],
        selected: [...requiredScopes, read],
        next: [...requiredScopes, modify],
      }),
    ).toBe(false);
    expect(
      shouldReconnectAfterRefresh({
        config,
        previous: [read],
        selected: [...requiredScopes, read],
        next: requiredScopes,
      }),
    ).toBe(true);
  });
  it("does not mistake an invalid token for confirmed grant revocation", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: "invalid_token" }), { status: 400 }));
    try {
      await expect(revokeGoogleAuthorization("old-token")).rejects.toThrow("unconfirmed");
    } finally {
      fetch.mockRestore();
    }
  });
  it("denies other owners and projects metadata instead of serializing storage rows", () => {
    expect(() => assertConnectionOwner({ ownerId: "owner", actorId: "attacker" })).toThrow(
      "not found",
    );
    const value = buildConnectionMetadata({
      row: {
        id: "c",
        status: "READY",
        selectedScopes: [read],
        grantedScopes: [modify],
        credentialId: "private",
        credential: { accessToken: "secret" },
        connector: { encryptedClientSecret: "secret" },
      } as never,
      connector: { ...config, enabled: true } as never,
    });
    expect(JSON.stringify(value)).not.toMatch(/credential|secret|accessToken/);
    expect(value.capabilities).toEqual(["gmail.read"]);
  });
  it("authorizes concrete operations and rejects target/header confusion", () => {
    expect(
      resolveConnectorOperation({
        path: "/gmail/v1/users/me/messages/send",
        query: new URLSearchParams(),
        method: "POST",
      }).capability,
    ).toBe("gmail.send");
    for (const path of [
      "//evil.example/mail",
      "/gmail/v1/users/me/messages/../send",
      "/calendar/v3/calendars/%2fattack",
      "/calendar/v3/calendars/%252fattack",
      "/gmail/v1/users/other/messages",
    ])
      expect(() =>
        resolveConnectorOperation({ path, query: new URLSearchParams(), method: "GET" }),
      ).toThrow();
    expect(() =>
      resolveConnectorOperation({
        path: "/gmail/v1/users/me/messages/a",
        query: new URLSearchParams(),
        method: "DELETE",
      }),
    ).toThrow();
    expect(() =>
      resolveConnectorOperation({
        path: "/gmail/v1/users/me/messages",
        query: new URLSearchParams("access_token=secret"),
        method: "GET",
      }),
    ).toThrow();
    expect(() =>
      resolveConnectorOperation({
        path: "/gmail/v1/users/me/messages",
        query: new URLSearchParams("alt=json&alt=media"),
        method: "GET",
      }),
    ).toThrow();
    const headers = buildUpstreamHeaders({
      input: new Headers({
        authorization: "DPoP private",
        dpop: "proof",
        cookie: "cookie",
        "x-goog-api-key": "bad",
        "content-type": "application/json",
      }),
      accessToken: "google",
    });
    expect([...headers.keys()].sort()).toEqual(["authorization", "content-type"]);
    expect(headers.get("authorization")).toBe("Bearer google");
  });
  it("bounds transfers and respects cancellation", async () => {
    await expect(readBoundedBody({ response: new Response("12345"), maximum: 4 })).rejects.toThrow(
      "limit",
    );
    await expect(
      readBoundedBody({ response: new Response("x"), maximum: 10, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
  it("plans configuration drift and accepts lifecycle addresses without declarative secrets", () => {
    const manifest = parseDesiredState({
      apiVersion: "weldall.dev/v1",
      workspace: {
        id: "67ade6dc-0000-4000-8000-000000000000",
        name: "test",
        issuer: "https://weldall.example.com",
      },
      connectors: { google: config },
    });
    const plan = createPlan(manifest, {
      revision: 1,
      objects: [
        {
          id: "c",
          kind: "connector",
          identity: "google",
          address: "connector.google",
          ownerWorkspaceId: manifest.workspace.id,
          version: 2,
          state: { ...config, name: "UI edit" },
        },
      ],
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ action: "update", drift: true, address: "connector.google" }),
    );
    expect(() =>
      parseDesiredState({
        ...manifest,
        connectors: { google: { ...config, clientSecret: "forbidden" } },
      }),
    ).toThrow();
    expect(
      importRequestSchema.safeParse({
        workspace: manifest.workspace,
        kind: "connector",
        identity: "google",
        address: "connector.google",
        operationId: crypto.randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      moveRequestSchema.safeParse({
        workspaceId: manifest.workspace.id,
        from: "connector.google",
        to: "connector.renamed",
        operationId: crypto.randomUUID(),
      }).success,
    ).toBe(true);
  });
});
