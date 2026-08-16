import { describe, expect, it, vi } from "vitest";

const { requireIacMachine } = vi.hoisted(() => ({ requireIacMachine: vi.fn() }));
vi.mock("../src/server/iac/auth", () => ({ requireIacMachine }));

import { iacRoute } from "../src/server/iac/http";

describe("IaC HTTP boundary", () => {
  it("shares one normalized request ID with the response and audit actor", async () => {
    requireIacMachine.mockImplementation(async (_request, _store, identifiers) => ({
      clientId: "runner",
      keyId: "key",
      keyThumbprint: "thumbprint",
      ...identifiers,
    }));
    const response = await iacRoute(
      new Request("https://weldall.example.com/api/iac/v1/plan", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "invalid request id" },
        body: "{}",
      }),
      async (_body, actor) => ({ auditRequestId: actor.requestId }),
    );
    const body = await response.json();
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.auditRequestId).toBe(response.headers.get("x-request-id"));
  });

  it("distinguishes malformed input from unexpected server failures", async () => {
    const request = () =>
      new Request("https://weldall.example.com/api/iac/v1/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    const malformed = await iacRoute(request(), async () => {
      throw new SyntaxError("invalid body");
    });
    const failed = await iacRoute(request(), async () => {
      throw new Error("database unavailable");
    });

    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
    expect(malformed.status).toBe(400);
    await expect(failed.json()).resolves.toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal error prevented the IaC request from completing",
      },
    });
    expect(failed.status).toBe(500);
  });
});
