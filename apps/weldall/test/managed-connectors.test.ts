import { describe, expect, it, vi } from "vitest";
import {
  availableScopes,
  effectiveCapabilities,
  refreshNeedsReconnect,
  requiredScopes,
  validateSelection,
  validateScopeConfig,
} from "../src/server/connectors/scopes";
import { resolveOperation } from "../src/server/connectors/registry";
import { assertOwner, connectionMetadata } from "../src/server/connectors/connections";
import { upstreamHeaders } from "../src/server/connectors/execution";
import { authorizationUrl, boundedBody, revokeGoogle } from "../src/server/connectors/google";
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
  encryptionKey: "test",
  clientId: "client",
  enabledApis: ["gmail", "calendar"] as ("gmail" | "calendar")[],
  allowedScopes: [read, modify, calendar],
  defaultScopes: [calendar],
};

describe("managed connector boundaries", () => {
  it("separates requirements, defaults, selection and actual grants", () => {
    expect(
      availableScopes(config)
        .filter((s) => s.required)
        .map((s) => s.id),
    ).toEqual(requiredScopes);
    expect(validateSelection(config, [...requiredScopes, calendar])).not.toContain(read);
    expect(() => validateSelection(config, [calendar])).toThrow("required");
    expect(() => validateSelection(config, [...requiredScopes, "tampered"])).toThrow();
    expect(() => validateSelection(config, requiredScopes)).toThrow("at least one");
    expect(() => validateScopeConfig({ ...config, defaultScopes: ["unknown"] })).toThrow();
    expect(effectiveCapabilities(config, [calendar, read], [calendar])).toEqual([
      "calendar.events.read",
      "calendar.read",
    ]);
    expect(effectiveCapabilities(config, [read], [modify])).toEqual(["gmail.read"]);
    expect(effectiveCapabilities(config, [modify], [modify])).toContain("gmail.send");
    expect(effectiveCapabilities({ ...config, allowedScopes: [read] }, [modify], [modify])).toEqual(
      ["gmail.read"],
    );
    const url = new URL(
      authorizationUrl({
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
      refreshNeedsReconnect(
        config,
        [modify],
        [...requiredScopes, read],
        [...requiredScopes, modify],
      ),
    ).toBe(true);
    expect(
      refreshNeedsReconnect(
        config,
        [modify],
        [...requiredScopes, modify],
        [...requiredScopes, read],
      ),
    ).toBe(false);
    expect(
      refreshNeedsReconnect(config, [read], [...requiredScopes, read], [...requiredScopes, modify]),
    ).toBe(false);
    expect(refreshNeedsReconnect(config, [read], [...requiredScopes, read], requiredScopes)).toBe(
      true,
    );
  });
  it("does not mistake an invalid token for confirmed grant revocation", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: "invalid_token" }), { status: 400 }));
    try {
      await expect(revokeGoogle("old-token")).rejects.toThrow("unconfirmed");
    } finally {
      fetch.mockRestore();
    }
  });
  it("denies other owners and projects metadata instead of serializing storage rows", () => {
    expect(() => assertOwner("owner", "attacker")).toThrow("not found");
    const value = connectionMetadata(
      {
        id: "c",
        status: "READY",
        selectedScopes: [read],
        grantedScopes: [modify],
        credentialId: "private",
        credential: { accessToken: "secret" },
        connector: { secretId: "secret" },
      } as never,
      { ...config, enabled: true } as never,
    );
    expect(JSON.stringify(value)).not.toMatch(/credential|secret|accessToken/);
    expect(value.capabilities).toEqual(["gmail.read"]);
  });
  it("authorizes concrete operations and rejects target/header confusion", () => {
    expect(
      resolveOperation("/gmail/v1/users/me/messages/send", new URLSearchParams(), "POST")
        .capability,
    ).toBe("gmail.send");
    for (const path of [
      "//evil.example/mail",
      "/gmail/v1/users/me/messages/../send",
      "/calendar/v3/calendars/%2fattack",
      "/calendar/v3/calendars/%252fattack",
      "/gmail/v1/users/other/messages",
    ])
      expect(() => resolveOperation(path, new URLSearchParams(), "GET")).toThrow();
    expect(() =>
      resolveOperation("/gmail/v1/users/me/messages/a", new URLSearchParams(), "DELETE"),
    ).toThrow();
    expect(() =>
      resolveOperation(
        "/gmail/v1/users/me/messages",
        new URLSearchParams("access_token=secret"),
        "GET",
      ),
    ).toThrow();
    expect(() =>
      resolveOperation(
        "/gmail/v1/users/me/messages",
        new URLSearchParams("alt=json&alt=media"),
        "GET",
      ),
    ).toThrow();
    const headers = upstreamHeaders(
      new Headers({
        authorization: "DPoP private",
        dpop: "proof",
        cookie: "cookie",
        "x-goog-api-key": "bad",
        "content-type": "application/json",
      }),
      "google",
    );
    expect([...headers.keys()].sort()).toEqual(["authorization", "content-type"]);
    expect(headers.get("authorization")).toBe("Bearer google");
  });
  it("bounds transfers and respects cancellation", async () => {
    await expect(boundedBody(new Response("12345"), 4)).rejects.toThrow("limit");
    await expect(boundedBody(new Response("x"), 10, AbortSignal.abort())).rejects.toThrow();
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
      encryptionKeys: {
        test: {
          key: "test",
          name: "Test",
          activeVersion: "1",
          versions: { "1": { source: { type: "env", name: "ARBITRARY_APPROVED_NAME" } } },
        },
      },
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
        kind: "encryptionKey",
        identity: "test",
        address: "encryptionKey.test",
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
