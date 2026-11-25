import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn((_request: Request) => new Response(null, { status: 204 })),
  getSession: vi.fn().mockResolvedValue(null),
  installationCompleted: vi.fn().mockResolvedValue(true),
}));
vi.mock("../src/server/auth/auth", () => ({
  auth: { handler: mocks.dispatch, api: { getSession: mocks.getSession } },
}));
vi.mock("../src/server/auth/login-service", () => ({
  installationCompleted: mocks.installationCompleted,
}));
import { GET, POST } from "../src/app/api/auth/[...all]/route";

const callback = "/callback/34f1c798-f286-4575-bb9a-dc157d168b20";
const request = (method: string, path: string) =>
  (method === "POST" ? POST : GET)(
    new Request(`https://weldall.example/api/auth${path}`, { method }),
  );

beforeEach(() => vi.clearAllMocks());

describe("public Better Auth catch-all", () => {
  it.each([
    ["GET", "/get-session"],
    ["GET", "/oidc/admin-providers"],
    ["GET", "/error"],
    ["GET", "/oauth2/authorize"],
    ["GET", callback + "?state=example"],
    ["POST", "/sign-out"],
    ["POST", "/oauth2/consent"],
    ["POST", "/oidc/start"],
    ["POST", "/oidc/setup"],
    ["POST", "/oidc/admin-draft"],
    ["POST", "/oidc/admin-test"],
    ["POST", "/oidc/admin-save"],
  ])("forwards %s %s", async (method, path) => {
    expect((await request(method, path)).status).toBe(204);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });

  it("still requires a completed installation before forwarding authorization", async () => {
    mocks.installationCompleted.mockResolvedValueOnce(false);
    expect((await request("GET", "/oauth2/authorize")).status).toBe(503);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "/update-user"],
    ["GET", "/token"],
    ["POST", "/oauth2/create-client"],
    ["POST", "/oauth2/introspect"],
    ["GET", "/oauth2/end-session"],
    ["GET", "/future-plugin"],
    ["POST", "/oidc/future-plugin"],
    ["POST", "/get-session"],
    ["GET", "/oidc/admin-save"],
    ["HEAD", "/get-session"],
    ["GET", "/callback/:providerId"],
    ["GET", "/callback/not-a-uuid"],
    ["GET", callback + "/extra"],
    ["POST", callback],
    ["POST", "/oauth2/token"],
    ["POST", "/oauth2/revoke"],
    ["GET", "/oauth2/userinfo"],
  ])("rejects %s %s without calling Better Auth", async (method, path) => {
    expect((await request(method, path)).status).toBe(404);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.installationCompleted).not.toHaveBeenCalled();
  });
});
