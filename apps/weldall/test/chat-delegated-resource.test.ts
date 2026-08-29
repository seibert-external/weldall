import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateEs256KeyPair: vi.fn(),
  issueIdJag: vi.fn(),
  createDpopProof: vi.fn(),
  getWeldallSigningKey: vi.fn(),
  findUser: vi.fn(),
  delegatedRequestPolicyFor: vi.fn(),
  auditWrite: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("@weldall/sdk", async () => {
  const actual = await vi.importActual<typeof import("@weldall/sdk")>("@weldall/sdk");
  return {
    ...actual,
    generateEs256KeyPair: mocks.generateEs256KeyPair,
    issueIdJag: mocks.issueIdJag,
    createDpopProof: mocks.createDpopProof,
  };
});
vi.mock("@weldall/db", async () => {
  const actual = await vi.importActual<typeof import("@weldall/db")>("@weldall/db");
  return {
    ...actual,
    db: { user: { findUnique: mocks.findUser } },
  };
});
vi.mock("../src/server/oauth/jwt", () => ({
  getWeldallSigningKey: mocks.getWeldallSigningKey,
}));
vi.mock("../src/server/policy/resources", () => ({
  delegatedRequestPolicyFor: mocks.delegatedRequestPolicyFor,
}));
vi.mock("../src/server/audit/service", () => ({
  prismaAuditWriter: { write: mocks.auditWrite },
}));
vi.mock("../src/server/observability/logger", () => ({
  logger: { info: mocks.loggerInfo },
}));
vi.mock("jose", async () => {
  const actual = await vi.importActual<typeof import("jose")>("jose");
  return {
    ...actual,
    decodeJwt: () => ({ jti: "jag-1", iat: 1_700_000_000, exp: 1_700_000_300 }),
  };
});

import { Prisma } from "@weldall/db";
import { delegatedResourceRequest } from "../src/server/ai/delegated-resource";

const resource = {
  key: "expenses",
  name: "Expenses",
  resourceIdentifier: "https://expenses.example/api",
  authorizationServer: "https://expenses.example",
  downstreamClientId: "expenses-client",
  requestPrefixes: ["https://expenses.example/api"],
  supportedScopes: ["expenses:read", "expenses:create"],
  grantedScopes: ["expenses:read", "expenses:create"],
};
const principal = { id: "user-1", email: "user@example.com", name: "User" };

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("delegated chat resource requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockResolvedValue({ email: principal.email, emailVerified: true });
    mocks.delegatedRequestPolicyFor.mockResolvedValue({
      authorized: true,
      matches: [resource],
    });
    mocks.generateEs256KeyPair.mockResolvedValue({
      privateJwk: { kty: "EC", d: "private" },
      publicJwk: { kty: "EC" },
      jkt: "a".repeat(43),
    });
    mocks.getWeldallSigningKey.mockResolvedValue({
      kid: "weldall-key",
      privateJwk: { kty: "EC", d: "private" },
      publicJwk: { kty: "EC" },
    });
    mocks.issueIdJag.mockResolvedValue("delegated-assertion");
    mocks.createDpopProof.mockResolvedValueOnce("token-proof").mockResolvedValueOnce("api-proof");
    mocks.auditWrite.mockResolvedValue(undefined);
  });

  it("performs an approved POST from the Weldall server with user-bound DPoP", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "downstream-token", token_type: "DPoP", expires_in: 600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "expense-1" }, 201));
    vi.stubGlobal("fetch", fetchMock);

    const result = await delegatedResourceRequest(principal, {
      url: "https://expenses.example/api/expenses",
      method: "POST",
      scopes: ["expenses:create"],
      json: { amount: 24 },
      toolCallId: "call-1",
      requestIdentifiers: { requestId: "request-1" },
      allowedResourceKeys: ["expenses"],
      skillSlug: "expenses.review",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://expenses.example/oauth/token",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("https://expenses.example/api/expenses"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ amount: 24 }),
        headers: expect.objectContaining({
          authorization: "DPoP downstream-token",
          dpop: "api-proof",
          "content-type": "application/json",
        }),
        redirect: "error",
      }),
    );
    expect(mocks.auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "chat_tool.requested",
        actorId: "user-1",
        clientId: "weldall-web-chat",
        deduplicationKey: expect.any(String),
      }),
    );
    expect(mocks.auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "id_jag.issued", actorId: "user-1" }),
    );
    expect(mocks.auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "chat_tool.succeeded", actorId: "user-1" }),
    );
    expect(result).toEqual({
      resource: { key: "expenses", name: "Expenses" },
      url: "https://expenses.example/api/expenses",
      method: "POST",
      status: 201,
      ok: true,
      data: { id: "expense-1" },
      responseBytes: JSON.stringify({ id: "expense-1" }).length,
    });
  });

  it("rejects replayed POST approvals before making a request", async () => {
    mocks.auditWrite.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "6.19.3",
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      delegatedResourceRequest(principal, {
        url: "https://expenses.example/api/expenses",
        method: "POST",
        scopes: ["expenses:create"],
        json: { amount: 24 },
        toolCallId: "call-1",
        requestIdentifiers: { requestId: "request-1" },
        allowedResourceKeys: ["expenses"],
        skillSlug: "expenses.review",
      }),
    ).rejects.toThrow("approved Weldall request has already been used");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unverified session identities before making a request", async () => {
    mocks.findUser.mockResolvedValue({ email: principal.email, emailVerified: false });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      delegatedResourceRequest(principal, {
        url: "https://expenses.example/api/expenses",
        method: "GET",
        scopes: ["expenses:read"],
        toolCallId: "call-1",
        requestIdentifiers: { requestId: "request-1" },
        allowedResourceKeys: ["expenses"],
        skillSlug: "expenses.review",
      }),
    ).rejects.toThrow("signed-in Weldall identity is no longer valid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects targets outside the selected skill before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      delegatedResourceRequest(principal, {
        url: "https://expenses.example/api/expenses",
        method: "GET",
        scopes: ["expenses:read"],
        toolCallId: "call-1",
        requestIdentifiers: { requestId: "request-1" },
        allowedResourceKeys: ["people"],
        skillSlug: "expenses.review",
      }),
    ).rejects.toThrow("selected skill does not allow requests to this resource");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
