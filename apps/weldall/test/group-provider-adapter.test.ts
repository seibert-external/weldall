import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GroupProviderRequestError,
  ManagementApiV1Adapter,
} from "../src/server/group-providers/management-api-v1.js";
import {
  decryptProviderToken,
  encryptProviderToken,
} from "../src/server/group-providers/credentials.js";
import { normalizeProviderBaseUrl } from "../src/server/group-providers/service.js";

const originalKey = process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY;

afterEach(() => {
  process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY = originalKey;
  delete process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY_VERSION;
});

describe("management-api-v1 adapter", () => {
  it("uses fixed encoded URLs and token authentication while tolerating unrelated fields", async () => {
    const request = vi.fn<typeof fetch>(async (url) => {
      const value = String(url);
      if (value.includes("users/?mail=")) {
        return json([
          {
            username: "alice/id",
            email: "Alice+tag@Example.com",
            is_active: true,
            password_date: "ignored",
          },
        ]);
      }
      if (value.includes("users/alice%2Fid/")) {
        return json({
          username: "alice/id",
          email: "alice+tag@example.com",
          is_active: true,
          groups: ["team/a", "team/a"],
          operating_system: "ignored",
        });
      }
      if (value.includes("groups/team%2Fa/")) {
        return json({
          ou: "team/a",
          cn: "Team A",
          description: "Example",
          direct_members: ["ignored"],
        });
      }
      return json([
        { ou: "team/a", cn: "Team A", description: "Example", dn: "ignored" },
        { ou: "other", cn: "Other", description: null },
      ]);
    });
    const adapter = new ManagementApiV1Adapter(
      { baseUrl: "https://provider.example", token: "top-secret" },
      request,
    );

    const summary = await adapter.findUserByEmail(" Alice+tag@Example.com ");
    expect(summary).toEqual({ id: "alice/id", email: "alice+tag@example.com", active: true });
    await expect(adapter.getUser(summary!.id)).resolves.toMatchObject({
      id: "alice/id",
      groupIds: ["team/a"],
    });
    await expect(adapter.getGroup("team/a")).resolves.toEqual({
      id: "team/a",
      name: "Team A",
      description: "Example",
    });
    await expect(adapter.searchGroups("team example", 10)).resolves.toHaveLength(1);
    await expect(adapter.getGroups(["other", "team/a", "missing"])).resolves.toEqual([
      { id: "other", name: "Other" },
      { id: "team/a", name: "Team A", description: "Example" },
    ]);

    expect(request.mock.calls[0]![0]).toBe(
      "https://provider.example/api/management/users/?mail=alice%2Btag%40example.com",
    );
    for (const [, init] of request.mock.calls) {
      expect(init).toMatchObject({ method: "GET", redirect: "manual" });
      expect(new Headers(init?.headers).get("authorization")).toBe("Token top-secret");
    }
  });

  it("fails closed for ambiguous users and invalid relevant fields", async () => {
    const ambiguous = new ManagementApiV1Adapter(
      { baseUrl: "https://provider.example", token: "secret" },
      vi.fn<typeof fetch>(async () =>
        json([
          { username: "one", email: "a@example.com", is_active: true },
          { username: "two", email: "a@example.com", is_active: true },
        ]),
      ),
    );
    await expect(ambiguous.findUserByEmail("a@example.com")).rejects.toMatchObject({
      category: "ambiguous_user",
    });

    const mismatched = new ManagementApiV1Adapter(
      { baseUrl: "https://provider.example", token: "secret" },
      vi.fn<typeof fetch>(async () =>
        json([{ username: "one", email: "other@example.com", is_active: true }]),
      ),
    );
    await expect(mismatched.findUserByEmail("a@example.com")).rejects.toMatchObject({
      category: "user_email_mismatch",
    });

    const malformed = new ManagementApiV1Adapter(
      { baseUrl: "https://provider.example", token: "secret" },
      vi.fn<typeof fetch>(async () => json([{ cn: "Missing ID", unrelated: true }])),
    );
    await expect(malformed.searchGroups("", 10)).rejects.toThrow();
  });

  it("reports the complete bounded group count when testing a connection", async () => {
    const groups = Array.from({ length: 101 }, (_, index) => ({
      ou: `group-${index}`,
      cn: `Group ${index}`,
    }));
    const adapter = new ManagementApiV1Adapter(
      { baseUrl: "https://provider.example", token: "secret" },
      vi.fn<typeof fetch>(async () => json(groups)),
    );
    await expect(adapter.testConnection()).resolves.toEqual({ groupCount: 101 });
  });

  it("rejects redirects, non-JSON responses, and oversized bodies without leaking secrets", async () => {
    const cases = [
      new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } }),
      new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }),
      new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "6000000" },
      }),
    ];
    for (const response of cases) {
      const adapter = new ManagementApiV1Adapter(
        { baseUrl: "https://127.0.0.1", token: "never-log-this" },
        vi.fn<typeof fetch>(async () => response),
      );
      const error = await adapter.searchGroups("", 10).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(GroupProviderRequestError);
      expect(String(error)).not.toContain("never-log-this");
      expect(String(error)).not.toContain("hello");
    }
  });
});

describe("group provider configuration security", () => {
  it("normalizes arbitrary HTTPS origins and rejects unsafe URL shapes", () => {
    expect(normalizeProviderBaseUrl("https://10.0.0.4/")).toBe("https://10.0.0.4");
    expect(normalizeProviderBaseUrl("https://groups.example:8443")).toBe(
      "https://groups.example:8443",
    );
    for (const value of [
      "http://groups.example",
      "https://user:pass@groups.example",
      "https://groups.example/path",
      "https://groups.example/?query=1",
    ]) {
      expect(() => normalizeProviderBaseUrl(value)).toThrow();
    }
  });

  it("encrypts credentials with provider-bound authenticated encryption", () => {
    process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptProviderToken("provider-one", "write-only-token");
    expect(encrypted.encryptedToken).not.toContain("write-only-token");
    expect(decryptProviderToken({ id: "provider-one", ...encrypted })).toBe("write-only-token");
    expect(() => decryptProviderToken({ id: "provider-two", ...encrypted })).toThrow(
      "cannot be decrypted",
    );
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
