import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt, decrypt, prepareSecretEncryption } from "../src/server/connectors/encryption";
import { getEnvelopeProvider } from "../src/server/connectors/envelope-providers";
import { logger } from "../src/server/observability/logger";

const connectorId = randomUUID();
const context = "connection:record:credentials";
const metadata = { provider: "OPENBAO" as const, formatVersion: 1, context, connectorId };
const ciphertext = `vault:v1:${Buffer.alloc(60, 5).toString("base64")}`;
const token = "private-openbao-token";
const dek = Buffer.alloc(32, 7);
const wrap = () => getEnvelopeProvider("OPENBAO").wrapDek({ dek, context: metadata });
const unwrap = (wrappedDek: unknown = { ciphertext }) =>
  getEnvelopeProvider("OPENBAO").unwrapDek({ wrappedDek, context: metadata });
const fetcher = vi.fn<typeof fetch>();
const response = (data: unknown) => new Response(JSON.stringify({ data, request_id: "request" }));

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WELDALL_OPENBAO_HOST", "http://127.0.0.1:8200/");
  vi.stubEnv("WELDALL_OPENBAO_TOKEN", token);
  vi.stubEnv("WELDALL_CONNECTOR_KEK", Buffer.alloc(32, 1).toString("base64"));
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  fetcher.mockReset().mockImplementation(async () => response({ ciphertext }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenBao envelope client", () => {
  it("uses one encrypt upsert, ordinary AES key type and authenticated connector metadata on every write", async () => {
    await wrap();
    await wrap();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe(`http://127.0.0.1:8200/v1/transit/encrypt/weldall-connector-${connectorId}`);
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", "X-Vault-Token": token },
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(init!.body as string);
      expect(Object.keys(body).sort()).toEqual(["associated_data", "plaintext", "type"]);
      expect(body.plaintext).toBe(dek.toString("base64"));
      expect(body.type).toBe("aes256-gcm96");
      expect(JSON.parse(Buffer.from(body.associated_data, "base64").toString())).toEqual([
        "weldall-envelope",
        "wrap",
        1,
        "OPENBAO",
        context,
        `weldall-connector-${connectorId}`,
      ]);
    }
  });

  it("round-trips a fresh DEK per write without persisting connector identity or configuration", async () => {
    const wrapped = new Map<string, { plaintext: string; aad: string; key: string }>();
    fetcher.mockImplementation(async (url, init) => {
      const body = JSON.parse(init!.body as string);
      const key = String(url).split("/").at(-1)!;
      if (String(url).includes("/encrypt/")) {
        const ciphertext = `vault:v1:${Buffer.alloc(60, wrapped.size + 1).toString("base64")}`;
        wrapped.set(ciphertext, { plaintext: body.plaintext, aad: body.associated_data, key });
        return response({ ciphertext });
      }
      const value = wrapped.get(body.ciphertext)!;
      if (value.key !== key || value.aad !== body.associated_data)
        return new Response("private rejection", { status: 400 });
      return response({ plaintext: value.plaintext });
    });
    const first = await encrypt({ ...metadata, plaintext: "private-credentials" });
    const second = await encrypt({ ...metadata, plaintext: "private-credentials" });
    expect(first.wrappedDek).not.toEqual(second.wrappedDek);
    expect(new Set([...wrapped.values()].map((v) => v.plaintext)).size).toBe(2);
    expect(Object.keys(first.wrappedDek)).toEqual(["ciphertext"]);
    for (const secret of [token, connectorId, "127.0.0.1", "private-credentials"])
      expect(JSON.stringify(first)).not.toContain(secret);
    await expect(decrypt({ envelope: first, context, connectorId })).resolves.toBe(
      "private-credentials",
    );
    await expect(
      decrypt({ envelope: first, context, connectorId: randomUUID() }),
    ).rejects.toMatchObject({ code: "openbao_rejected", status: 503 });
    await expect(
      decrypt({
        envelope: { ...first, context: "another-purpose" },
        context: "another-purpose",
        connectorId,
      }),
    ).rejects.toMatchObject({ code: "openbao_rejected" });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("never trusts a connector identity supplied by stored envelope fields", async () => {
    const envelope = await encrypt({ ...metadata, plaintext: "credentials" });
    fetcher.mockClear();
    await expect(
      decrypt({ envelope: { ...envelope, connectorId } as typeof envelope, context }),
    ).rejects.toMatchObject({ code: "envelope_context_mismatch", status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("makes a fresh decrypt call on every read, with the identical associated data", async () => {
    await wrap();
    const aad = JSON.parse(fetcher.mock.calls[0]![1]!.body as string).associated_data;
    fetcher.mockImplementation(async () => response({ plaintext: dek.toString("base64") }));
    expect(await unwrap()).toEqual(dek);
    expect(await unwrap()).toEqual(dek);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({
      ciphertext,
      associated_data: aad,
    });
  });

  it("prepares a single-use refresh writer and disposes it even when abandoned", async () => {
    const provider = getEnvelopeProvider("OPENBAO");
    const original = provider.wrapDek;
    let transientDek: Buffer | undefined;
    vi.spyOn(provider, "wrapDek").mockImplementation((input) => {
      transientDek = input.dek;
      return original(input);
    });
    const prepared = await prepareSecretEncryption(metadata);
    const envelope = prepared.encrypt("credentials");
    expect(transientDek?.every((byte) => byte === 0)).toBe(true);
    expect(envelope.wrappedDek).toEqual({ ciphertext });
    expect(() => prepared.encrypt("second write")).toThrow("unavailable");
    const abandoned = await prepareSecretEncryption(metadata);
    abandoned.dispose();
    expect(transientDek?.every((byte) => byte === 0)).toBe(true);
    expect(() => abandoned.encrypt("lost race")).toThrow("unavailable");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["WELDALL_OPENBAO_HOST", "WELDALL_OPENBAO_TOKEN"])(
    "reads missing %s only at operation time and recovers without repair",
    async (name) => {
      const previous = process.env[name];
      vi.stubEnv(name, undefined);
      expect(getEnvelopeProvider("OPENBAO")).toBeDefined();
      await expect(wrap()).rejects.toMatchObject({
        code: "openbao_configuration_missing",
        status: 503,
      });
      await expect(unwrap()).rejects.toMatchObject({
        code: "openbao_configuration_missing",
        status: 503,
      });
      const local = await encrypt({ provider: "LOCAL_ENV", context, plaintext: "local" });
      await expect(decrypt({ envelope: local, context })).resolves.toBe("local");
      expect(fetcher).not.toHaveBeenCalled();
      vi.stubEnv(name, previous);
      await expect(wrap()).resolves.toEqual({ ciphertext });
    },
  );

  it.each([
    ["production", "http://127.0.0.1:8200"],
    ["test", "http://bao.example.com"],
    ["test", "https://user:secret@bao.example.com"],
    ["test", "https://bao.example.com/path"],
    ["test", "https://bao.example.com/?secret"],
    ["test", "https://bao.example.com/#secret"],
    ["test", "https://bao.example.com//"],
    ["test", "file:///private"],
    ["test", " https://bao.example.com"],
    ["test", "https://bao.example.com/.."],
  ])("rejects unsafe origin in %s (%s)", async (environment, host) => {
    vi.stubEnv("NODE_ENV", environment);
    vi.stubEnv("WELDALL_OPENBAO_HOST", host);
    await expect(wrap()).rejects.toMatchObject({ code: "openbao_configuration_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ["production", "https://bao.example.com"],
    ["development", "http://localhost:8200"],
    ["test", "http://[::1]:8200/"],
  ])("accepts valid origin in %s (%s)", async (environment, host) => {
    vi.stubEnv("NODE_ENV", environment);
    vi.stubEnv("WELDALL_OPENBAO_HOST", host);
    await expect(wrap()).resolves.toEqual({ ciphertext });
  });

  it.each([
    null,
    {},
    { ciphertext: "not-transit" },
    { ciphertext, host: "private-host" },
    { ciphertext: "vault:v0:AA==" },
  ])("strictly rejects wrapped output (%#) without I/O", async (wrapped) => {
    await expect(unwrap(wrapped)).rejects.toMatchObject({ code: "envelope_invalid", status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { ciphertext: "private-invalid" },
    { ciphertext: 123 },
    { ciphertext: "vault:v1:AA==" },
  ])("rejects malformed encrypt responses (%#)", async (data) => {
    fetcher.mockResolvedValue(response(data));
    await expect(wrap()).rejects.toMatchObject({ code: "openbao_response_invalid" });
  });
  it.each([
    undefined,
    3,
    "",
    "private-non-base64",
    Buffer.alloc(31).toString("base64"),
    dek.toString("base64") + "\n",
    dek.toString("base64").replace(/=$/, ""),
  ])("requires canonical 32-byte decrypt plaintext (%#)", async (plaintext) => {
    fetcher.mockResolvedValue(response({ plaintext }));
    await expect(unwrap()).rejects.toMatchObject({ code: "openbao_response_invalid", status: 503 });
  });
  it.each(["private-invalid-json", "x".repeat(16_385)])(
    "bounds and validates the response body (%#)",
    async (body) => {
      fetcher.mockResolvedValue(new Response(body));
      await expect(wrap()).rejects.toMatchObject({ code: "openbao_response_invalid" });
    },
  );
  it.each([403, 429, 500, 503])(
    "sanitizes HTTP %i without retrying or exposing any sensitive input",
    async (status) => {
      fetcher.mockResolvedValue(new Response("private-response-body", { status }));
      const error = await wrap().catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: status >= 500 ? "openbao_unavailable" : "openbao_rejected",
        status: 503,
        message: "Encryption is unavailable. Try again later.",
      });
      expect(error).not.toHaveProperty("cause");
      const diagnostics = JSON.stringify({ error, logs: vi.mocked(logger.error).mock.calls });
      for (const secret of [
        token,
        dek.toString("base64"),
        ciphertext,
        connectorId,
        context,
        "127.0.0.1",
        "private-response-body",
        "/v1/transit/",
      ])
        expect(diagnostics).not.toContain(secret);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps the deadline active while consuming the response body", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    fetcher.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream({
            start(stream) {
              controller.signal.addEventListener("abort", () =>
                stream.error(new Error("private-body-timeout")),
              );
              queueMicrotask(() => controller.abort());
            },
          }),
        ),
    );
    await expect(wrap()).rejects.toMatchObject({ code: "openbao_timeout", status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sanitizes network failure and a bounded timeout, then recovers on an explicit retry", async () => {
    fetcher.mockRejectedValueOnce(new Error("private-network-error"));
    await expect(wrap()).rejects.toMatchObject({ code: "openbao_unavailable" });
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    fetcher.mockImplementationOnce(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new Error("private-timeout-error");
    });
    await expect(wrap()).rejects.toMatchObject({ code: "openbao_timeout" });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(5_000);
    await expect(wrap()).resolves.toEqual({ ciphertext });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("private-");
  });
});
