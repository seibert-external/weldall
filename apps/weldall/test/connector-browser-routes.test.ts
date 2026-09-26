import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  effectiveScopes: vi.fn(),
  completeConnection: vi.fn(),
  submitScopeSelection: vi.fn(),
  getAuthorizationAttempt: vi.fn(),
}));
vi.mock("../src/server/auth/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("../src/server/policy/resources", () => ({
  effectiveScopesRequiringSystemScopeFor: mocks.effectiveScopes,
}));
vi.mock("../src/server/connectors/core/connections", () => ({
  completeConnection: mocks.completeConnection,
  submitScopeSelection: mocks.submitScopeSelection,
  getAuthorizationAttempt: mocks.getAuthorizationAttempt,
}));
import { GET as callback } from "../src/app/api/connectors/google/callback/route";
import { POST as submit } from "../src/app/api/connectors/setup/[id]/route";
import { WELDALL_ISSUER } from "../src/server/oauth/constants";

const session = {
  user: { id: "owner", email: "owner@example.com", emailVerified: true },
  session: { id: "authenticated-browser-session" },
};
const context = { params: Promise.resolve({ id: "attempt" }) };
const callbackRequest = (query = "state=state&code=code") =>
  new Request(`${WELDALL_ISSUER}/api/connectors/google/callback?${query}`, {
    headers: { cookie: "signed-session-cookie", "sec-fetch-site": "cross-site" },
  });
const setupRequest = (body: unknown = { selection: { scopes: ["openid"] } }) =>
  new Request(`${WELDALL_ISSUER}/api/connectors/setup/attempt`, {
    method: "POST",
    headers: {
      origin: WELDALL_ISSUER,
      "content-type": "application/json",
      "x-weldall-csrf": "1",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSession.mockResolvedValue(session);
  mocks.effectiveScopes.mockResolvedValue(["weldall:login"]);
  mocks.completeConnection.mockResolvedValue("success");
  mocks.submitScopeSelection.mockResolvedValue({ url: "https://accounts.google.com/authorize" });
});
afterEach(() => vi.restoreAllMocks());

describe("connector browser authentication", () => {
  it.each([
    ["missing or expired session", null],
    ["unverified user", { ...session, user: { ...session.user, emailVerified: false } }],
  ])("rejects callbacks with %s before claiming state", async (_label, value) => {
    mocks.getSession.mockResolvedValue(value);
    const request = new Request(
      `${WELDALL_ISSUER}/api/connectors/google/callback?state=state&code=code`,
    );
    const response = await callback(request);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${WELDALL_ISSUER}/api/connectors/result/failed`);
    expect(mocks.completeConnection).not.toHaveBeenCalled();
  });

  it("requires current login permission at the browser boundary", async () => {
    mocks.effectiveScopes.mockResolvedValue(null);
    const response = await callback(callbackRequest());
    expect(response.headers.get("location")).toMatch(/\/failed$/);
    expect(mocks.completeConnection).not.toHaveBeenCalled();
  });

  it("uses the authenticated Weldall user for callback ownership, not the query parameters", async () => {
    const request = callbackRequest("state=state&code=code&id=attacker");
    const response = await callback(request);
    expect(mocks.getSession).toHaveBeenCalledWith({ headers: request.headers });
    expect(mocks.completeConnection).toHaveBeenCalledWith({
      browser: expect.objectContaining({ id: session.user.id }),
      state: "state",
      code: "code",
      cancelled: false,
    });
    expect(response.headers.get("location")).toBe(
      `${WELDALL_ISSUER}/api/connectors/result/success`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).not.toContain(session.session.id);
  });

  it("also authenticates the Weldall user for provider cancellation", async () => {
    mocks.completeConnection.mockResolvedValue("cancelled");
    const response = await callback(callbackRequest("state=state&error=access_denied"));
    expect(mocks.completeConnection).toHaveBeenCalledWith({
      browser: expect.objectContaining({ id: session.user.id }),
      state: "state",
      code: null,
      cancelled: true,
    });
    expect(response.headers.get("location")).toMatch(/\/cancelled$/);
  });

  it("accepts another valid session of the same Weldall user after setup", async () => {
    const response = await submit(setupRequest(), context);
    expect(response.status).toBe(200);
    expect(mocks.submitScopeSelection).toHaveBeenCalledWith({
      actor: expect.objectContaining({ id: session.user.id }),
      id: "attempt",
      selection: { scopes: ["openid"] },
    });
    expect(await response.json()).toEqual({ url: "https://accounts.google.com/authorize" });
    mocks.getSession.mockResolvedValue({ ...session, session: { id: "another-valid-session" } });
    expect((await callback(callbackRequest())).headers.get("location")).toMatch(/\/success$/);
    expect(mocks.completeConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        browser: {
          ...mocks.submitScopeSelection.mock.calls[0][0].actor,
          requestId: expect.any(String),
        },
      }),
    );
  });

  it("rejects caller-supplied ownership and untrusted setup POSTs", async () => {
    const forged = await submit(setupRequest({ selection: {}, ownerId: "attacker" }), context);
    expect(forged.status).toBe(400);
    const request = setupRequest();
    request.headers.set("origin", "https://attacker.example.com");
    const untrusted = await submit(request, context);
    expect(untrusted.status).toBe(403);
    expect(mocks.submitScopeSelection).not.toHaveBeenCalled();
  });
});
