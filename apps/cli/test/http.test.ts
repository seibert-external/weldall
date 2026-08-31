import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { createHttpsDeadlineFetch, successfulResponse } from "../src/http.js";

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
