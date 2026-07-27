import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { createHttpsDeadlineFetch } from "../src/http.js";

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
