import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  status: 200,
  contentType: "application/json",
  body: '{"ok":true}',
  requests: [] as Array<{ url: URL; options: Record<string, any> }>,
  stall: false,
}));

vi.mock("node:https", () => ({
  request: (url: URL, options: Record<string, any>, callback: Function) => {
    fixture.requests.push({ url, options });
    const req = new EventEmitter() as EventEmitter & { end: Function; destroy: Function };
    req.destroy = () => req.emit("close");
    req.end = () => {
      if (fixture.stall) return;
      const response = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        destroy: Function;
      };
      response.statusCode = fixture.status;
      response.headers = {
        "content-type": fixture.contentType,
        location: "https://evil.example.com",
      };
      response.destroy = () => {};
      callback(response);
      response.emit("data", Buffer.from(fixture.body));
      response.emit("end");
      req.emit("close");
    };
    return req;
  },
}));

import { oidcJson } from "../src/server/auth/oidc-transport";

beforeEach(() => {
  fixture.status = 200;
  fixture.contentType = "application/json";
  fixture.body = '{"ok":true}';
  fixture.requests = [];
  fixture.stall = false;
});

afterEach(() => {
  vi.useRealTimers();
});

it("uses bounded verified HTTPS without application-layer destination filtering", async () => {
  await expect(oidcJson("https://127.0.0.1/jwks")).resolves.toEqual({ ok: true });
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]!.options.rejectUnauthorized).toBe(true);
  expect(fixture.requests[0]!.options.agent).toBe(false);
});

it("never follows redirects and sends credentials only on the requested call", async () => {
  fixture.status = 302;
  await expect(
    oidcJson("https://id.example.com/token", {
      authorization: "Basic secret",
      body: new URLSearchParams({ code: "code" }),
    }),
  ).rejects.toThrow("upstream_unavailable");
  expect(fixture.requests[0]!.options.headers).toMatchObject({
    authorization: "Basic secret",
    "content-type": "application/x-www-form-urlencoded",
  });

  fixture.status = 200;
  await oidcJson("https://id.example.com/config");
  expect(fixture.requests[1]!.options.headers).not.toHaveProperty("authorization");
});

it("rejects invalid content types, oversized payloads, and non-object JSON", async () => {
  fixture.contentType = "text/html";
  await expect(oidcJson("https://id.example.com/config")).rejects.toThrow();
  fixture.contentType = "application/json";
  fixture.body = JSON.stringify({ data: "x".repeat(256 * 1024) });
  await expect(oidcJson("https://id.example.com/config")).rejects.toThrow();
  fixture.body = "[]";
  await expect(oidcJson("https://id.example.com/config")).rejects.toThrow();
});

it("bounds the entire request even if connection establishment stalls", async () => {
  vi.useFakeTimers();
  fixture.stall = true;
  const pending = expect(oidcJson("https://id.example.com/config")).rejects.toThrow(
    "upstream_unavailable",
  );
  await vi.advanceTimersByTimeAsync(8000);
  await pending;
});
