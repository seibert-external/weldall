import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  boundedJsonResponse,
  createHttpsDeadlineFetch,
  successfulResponse,
  successfulResponseStream,
} from "../src/http.js";

describe("response errors", () => {
  it("adds a configuration-refresh hint only for missing cached endpoints", async () => {
    await expect(
      successfulResponse(new Response(null, { status: 404 }), "Weldall endpoint", "refresh it"),
    ).rejects.toMatchObject({ hint: "refresh it" });
    await expect(
      successfulResponse(new Response(null, { status: 401 }), "Weldall endpoint", "refresh it"),
    ).rejects.toMatchObject({ hint: undefined });
  });

  it("surfaces structured field errors from the response body", async () => {
    const body = JSON.stringify({
      errors: [{ field: "sort", message: "Invalid option: expected one of asc|desc" }],
    });
    await expect(
      successfulResponse(
        new Response(body, { status: 400, headers: { "content-type": "application/json" } }),
        "GET https://gateway.example/personio/employees",
      ),
    ).rejects.toThrow(
      "GET https://gateway.example/personio/employees failed with HTTP 400: sort: Invalid option: expected one of asc|desc",
    );
  });

  it("prefers OAuth error_description and falls back to a compact JSON body", async () => {
    await expect(
      successfulResponse(
        Response.json(
          { error: "invalid_scope", error_description: "scope not granted" },
          { status: 403 },
        ),
        "Weldall token endpoint",
      ),
    ).rejects.toThrow("Weldall token endpoint failed with HTTP 403: scope not granted");
    await expect(
      successfulResponse(
        Response.json({ code: "E_VALIDATION", invalid: ["sort"] }, { status: 400 }),
        "POST https://gateway.example/api/expenses",
      ),
    ).rejects.toThrow(
      'POST https://gateway.example/api/expenses failed with HTTP 400: {"code":"E_VALIDATION","invalid":["sort"]}',
    );
  });

  it.each([
    ["JSON", successfulResponse],
    ["stream", successfulResponseStream],
  ] as const)("bounds streamed HTTP errors before decoding (%s)", async (_, read) => {
    let bytes = 0;
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          if (bytes === 20 * 1024 * 1024) return controller.close();
          const chunk = new Uint8Array(64 * 1024).fill(120);
          bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 500 },
    );
    await expect(read(response, "Native MCP")).rejects.toThrow("Native MCP failed with HTTP 500");
    expect(cancelled).toBe(true);
    expect(bytes).toBeLessThanOrEqual(128 * 1024);
  });

  it("keeps text bodies and bounds oversized JSON fallbacks", async () => {
    await expect(
      successfulResponse(new Response("rate limited", { status: 429 }), "Weldall endpoint"),
    ).rejects.toThrow("Weldall endpoint failed with HTTP 429: rate limited");

    const longBody = { long: "x".repeat(10_000) };
    const compactPrefix = JSON.stringify(longBody).slice(0, 400);
    await expect(
      successfulResponse(
        new Response(JSON.stringify(longBody), { status: 500 }),
        "Weldall endpoint",
      ),
    ).rejects.toThrow(`Weldall endpoint failed with HTTP 500: ${compactPrefix}`);
  });
});

describe("bounded discovery JSON", () => {
  it("bounds unknown-length streams and cancels the body", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(50));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    await expect(boundedJsonResponse(response, new AbortController().signal, 64)).rejects.toThrow(
      "size limit",
    );
    expect(cancelled).toBe(true);
  });
  it("cancels a stalled body and never reflects upstream diagnostics", async () => {
    const controller = new AbortController();
    const response = new Response(new ReadableStream({ start() {} }));
    const reading = boundedJsonResponse(response, controller.signal);
    controller.abort();
    await expect(reading).rejects.toThrow();
    await expect(
      boundedJsonResponse(new Response("secret", { status: 500 }), new AbortController().signal),
    ).rejects.toThrow("HTTP 500");
  });
});

describe("HTTPS deadline fetch", () => {
  it("destroys a stalled connection at the deadline", async () => {
    const sockets: Socket[] = [];
    const server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test server address");

      await expect(
        createHttpsDeadlineFetch(50)(`https://127.0.0.1:${address.port}`),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
