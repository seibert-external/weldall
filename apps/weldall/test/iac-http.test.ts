import { describe, expect, it, vi } from "vitest";

const { requireIacMachine } = vi.hoisted(() => ({ requireIacMachine: vi.fn() }));
vi.mock("../src/server/iac/auth", () => ({ requireIacMachine }));

import { iacRoute } from "../src/server/iac/http";

describe("IaC HTTP request identifiers", () => {
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
});
