import { describe, expect, it } from "vitest";
import { withRequestLogging } from "../src/server/observability/http";
import {
  createAppLogger,
  errorForLog,
  logger,
  resolveLogLevel,
} from "../src/server/observability/logger";

type CapturedRecord = Record<string, any>;

describe("structured logging", () => {
  it("propagates isolated request context and returns the request ID", async () => {
    const records: CapturedRecord[] = [];
    const detach = logger.attachTransport((record) => records.push(record as CapturedRecord));
    const handler = withRequestLogging("/test/[id]", async (request) => {
      await new Promise((resolve) =>
        setTimeout(resolve, request.headers.get("x-delay") === "1" ? 5 : 0),
      );
      logger.info({ event: "test.inside" }, "inside request");
      return Response.json({ requestId: request.headers.get("x-request-id") });
    });

    try {
      const [first, second] = await Promise.all([
        handler(
          new Request("https://weldall.example/test/first", {
            headers: { "x-request-id": "request-first", "x-delay": "1" },
          }),
        ),
        handler(
          new Request("https://weldall.example/test/second", {
            headers: { "x-request-id": "request-second" },
          }),
        ),
      ]);

      await expect(first.json()).resolves.toEqual({ requestId: "request-first" });
      await expect(second.json()).resolves.toEqual({ requestId: "request-second" });
      expect(first.headers.get("x-request-id")).toBe("request-first");
      expect(second.headers.get("x-request-id")).toBe("request-second");

      const inside = records.filter((record) => record[0]?.event === "test.inside");
      expect(inside.map((record) => record._logMeta.requestId).sort()).toEqual([
        "request-first",
        "request-second",
      ]);
      expect(inside).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            _logMeta: expect.objectContaining({ method: "GET", route: "/test/[id]" }),
          }),
        ]),
      );
    } finally {
      detach();
    }
  });

  it("normalizes invalid identifiers before downstream handlers see them", async () => {
    const handler = withRequestLogging("/test", (request) =>
      Response.json({ requestId: request.headers.get("x-request-id") }),
    );
    const response = await handler(
      new Request("https://weldall.example/test", {
        headers: {
          "x-request-id": "invalid request id",
          "x-correlation-id": "invalid correlation id",
        },
      }),
    );
    const body = (await response.json()) as { requestId: string };

    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("x-request-id")).toBe(body.requestId);
  });

  it("redacts secret keys and credential-shaped strings", () => {
    const records: CapturedRecord[] = [];
    const testLogger = createAppLogger({
      type: "hidden",
      attachedTransports: [(record) => records.push(record as CapturedRecord)],
    });

    testLogger.info(
      {
        authorization: "Bearer secret-value",
        nested: { access_token: "eyJheader.eyJpayload.signature" },
        messageWithCredential: "received DPoP abc.def.ghi",
        diagnostic:
          "user@example.com could not connect to postgresql://database:password@postgres:5432/weldall",
        error: errorForLog(new Error("request for admin@example.com used Bearer top-secret")),
      },
      "credential test",
    );

    expect(records[0]?.[0]).toMatchObject({
      authorization: "[***]",
      nested: { access_token: "[***]" },
      messageWithCredential: "received [***]",
      diagnostic: "[***] could not connect to [***]postgres:5432/weldall",
      error: expect.objectContaining({ message: "request for [***] used [***]" }),
    });
  });

  it("uses INFO by default and rejects invalid configured levels", () => {
    expect(resolveLogLevel(undefined)).toBe("INFO");
    expect(resolveLogLevel("debug")).toBe("DEBUG");
    expect(() => resolveLogLevel("verbose")).toThrow('Invalid LOG_LEVEL "verbose"');
  });
});
