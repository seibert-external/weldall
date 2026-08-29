import { describe, expect, it } from "vitest";
import {
  normalizeChatApiKey,
  normalizeChatBaseUrl,
  normalizeChatModel,
  resolveChatToolApprovalSecret,
} from "../src/server/ai/configuration";
import { decryptChatApiKey, encryptChatApiKey } from "../src/server/ai/credentials";

describe("chat model configuration", () => {
  it("normalizes provider settings", () => {
    expect(normalizeChatBaseUrl(" https://vllm.example.com/v1/ ")).toBe(
      "https://vllm.example.com/v1",
    );
    expect(normalizeChatModel(" model-name ")).toBe("model-name");
    expect(normalizeChatApiKey(" secret-token ")).toBe("secret-token");
  });

  it("accepts a loopback HTTP provider outside production", () => {
    expect(normalizeChatBaseUrl("http://localhost:8000/v1", { NODE_ENV: "development" })).toBe(
      "http://localhost:8000/v1",
    );
  });

  it("rejects unsafe provider settings", () => {
    expect(() =>
      normalizeChatBaseUrl("http://vllm.internal/v1", { NODE_ENV: "production" }),
    ).toThrow("must use HTTPS");
    expect(() => normalizeChatBaseUrl("https://user:pass@example.com/v1")).toThrow(
      "must use HTTPS",
    );
    expect(() => normalizeChatModel("  ")).toThrow("must contain 1 to 200");
    expect(() => normalizeChatApiKey("line\nbreak")).toThrow("without control characters");
  });

  it("encrypts the stored API key with settings-bound authenticated encryption", () => {
    const previousEncryptionKey = process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY;
    process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      const encrypted = encryptChatApiKey("default", "test-api-key");

      expect(encrypted.encryptedApiKey).not.toContain("test-api-key");
      expect(decryptChatApiKey({ id: "default", ...encrypted })).toBe("test-api-key");
      expect(() => decryptChatApiKey({ id: "other", ...encrypted })).toThrow("cannot be decrypted");
    } finally {
      if (previousEncryptionKey === undefined) delete process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY;
      else process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY = previousEncryptionKey;
    }
  });

  it("derives a stable, domain-separated tool approval secret", () => {
    const first = resolveChatToolApprovalSecret("user-1", {
      BETTER_AUTH_SECRET: "test-secret",
    });
    const second = resolveChatToolApprovalSecret("user-1", {
      BETTER_AUTH_SECRET: "test-secret",
    });
    const otherUser = resolveChatToolApprovalSecret("user-2", {
      BETTER_AUTH_SECRET: "test-secret",
    });

    expect(first).toEqual(second);
    expect(first).not.toEqual(otherUser);
    expect(first).toHaveLength(32);
    expect(() => resolveChatToolApprovalSecret("user-1", {})).toThrow(
      "BETTER_AUTH_SECRET is required",
    );
  });
});
