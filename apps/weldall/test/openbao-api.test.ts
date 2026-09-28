import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { encrypt, decrypt } from "../src/server/connectors/encryption";
import { logger } from "../src/server/observability/logger";

// Opt-in JS API compatibility check, not product E2E. Requires an operator token and an
// already-enabled transit/ mount on a disposable loopback OpenBao 2.7 instance.
// Only test-owned keys, policy and short-lived token are created/removed by this harness.
const operatorToken = process.env.WELDALL_OPENBAO_TEST_TOKEN;
const host = process.env.WELDALL_OPENBAO_TEST_HOST ?? "http://127.0.0.1:8200";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.skipIf(!operatorToken)(
  "OpenBao 2.7 restricted-policy lazy upsert, isolation, concurrency and rotation",
  async () => {
    expect(new URL(host).hostname).toBe("127.0.0.1");
    const nativeFetch = globalThis.fetch;
    const operator = async (path: string, method = "GET", body?: object) => {
      const response = await nativeFetch(`${host}/v1/${path}`, {
        method,
        headers: { "X-Vault-Token": operatorToken!, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      return response;
    };
    const check = async (path: string, method: string, body?: object) => {
      const response = await operator(path, method, body);
      if (!response.ok) throw new Error(`OpenBao test setup/cleanup failed (${response.status}).`);
      await response.body?.cancel();
    };
    const health = await operator("sys/health");
    expect(health.status).toBe(200);
    expect((await health.json()).version).toMatch(/^2\.7\./);
    const ids = [randomUUID(), randomUUID()];
    const keys = ids.map((id) => `weldall-connector-${id}`);
    const policyName = `weldall-envelope-test-${randomUUID()}`;
    let restrictedToken: string | undefined;
    try {
      const policy = keys
        .map(
          (key) =>
            `path "transit/encrypt/${key}" { capabilities = ["create", "update"] }\npath "transit/decrypt/${key}" { capabilities = ["update"] }`,
        )
        .join("\n");
      await check(`sys/policies/acl/${policyName}`, "PUT", { policy });
      const created = await operator("auth/token/create", "POST", {
        policies: [policyName],
        no_default_policy: true,
        ttl: "5m",
        explicit_max_ttl: "5m",
        renewable: false,
      });
      expect(created.status).toBe(200);
      restrictedToken = (await created.json()).auth.client_token;
      if (!restrictedToken) throw new Error("OpenBao test token creation failed.");
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("WELDALL_OPENBAO_HOST", host);
      vi.stubEnv("WELDALL_OPENBAO_TOKEN", restrictedToken);
      vi.spyOn(logger, "error").mockImplementation(() => undefined);
      const fetcher = vi.spyOn(globalThis, "fetch");
      for (const key of keys) {
        const absent = await operator(`transit/keys/${key}`);
        expect(absent.status).toBe(404);
        await absent.body?.cancel();
      }
      const context = "attempt:api-compatibility:oauth";
      const write = (connectorId: string) =>
        encrypt({ provider: "OPENBAO", connectorId, context, plaintext: "api-test-credentials" });
      const [first, concurrent] = await Promise.all([write(ids[0]!), write(ids[0]!)]);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(
        fetcher.mock.calls.every(
          ([url]) => String(url) === `${host}/v1/transit/encrypt/${keys[0]}`,
        ),
      ).toBe(true);
      expect(first.wrappedDek.ciphertext).toMatch(/^vault:v1:/);
      expect(concurrent.wrappedDek.ciphertext).toMatch(/^vault:v1:/);
      expect(first.wrappedDek).not.toEqual(concurrent.wrappedDek);
      for (const envelope of [first, concurrent]) {
        fetcher.mockClear();
        await expect(decrypt({ envelope, connectorId: ids[0]!, context })).resolves.toBe(
          "api-test-credentials",
        );
        expect(fetcher).toHaveBeenCalledTimes(1);
      }
      const second = await write(ids[1]!);
      await expect(decrypt({ envelope: second, connectorId: ids[1]!, context })).resolves.toBe(
        "api-test-credentials",
      );
      await expect(
        decrypt({ envelope: first, connectorId: ids[1]!, context }),
      ).rejects.toMatchObject({ code: "openbao_rejected", status: 503 });
      const otherPurpose = "attempt:another:oauth";
      await expect(
        decrypt({
          envelope: { ...first, context: otherPurpose },
          connectorId: ids[0]!,
          context: otherPurpose,
        }),
      ).rejects.toMatchObject({ code: "openbao_rejected" });
      for (const key of keys) {
        const metadata = await operator(`transit/keys/${key}`);
        expect(metadata.status).toBe(200);
        expect((await metadata.json()).data).toMatchObject({
          name: key,
          type: "aes256-gcm96",
          derived: false,
          latest_version: 1,
        });
        const forbidden = await nativeFetch(`${host}/v1/transit/keys/${key}`, {
          headers: { "X-Vault-Token": restrictedToken },
          signal: AbortSignal.timeout(5_000),
        });
        expect(forbidden.status).toBe(403);
        await forbidden.body?.cancel();
      }
      await check(`transit/keys/${keys[0]}/rotate`, "POST", {});
      fetcher.mockClear();
      const rotated = await write(ids[0]!);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(rotated.wrappedDek.ciphertext).toMatch(/^vault:v2:/);
      for (const envelope of [first, rotated])
        await expect(decrypt({ envelope, connectorId: ids[0]!, context })).resolves.toBe(
          "api-test-credentials",
        );
    } finally {
      // Explicit operator cleanup is test-only; Weldall itself never calls keys/* or administration APIs.
      if (restrictedToken) await check("auth/token/revoke", "POST", { token: restrictedToken });
      for (const key of keys) {
        const response = await operator(`transit/keys/${key}`);
        await response.body?.cancel();
        if (response.status === 404) continue;
        if (!response.ok) throw new Error("OpenBao test key cleanup could not inspect test key.");
        await check(`transit/keys/${key}/config`, "POST", { deletion_allowed: true });
        await check(`transit/keys/${key}`, "DELETE");
      }
      await check(`sys/policies/acl/${policyName}`, "DELETE");
    }
  },
  30_000,
);
