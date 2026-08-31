import { db } from "@weldall/db";
import { decryptChatApiKey } from "./credentials";

export const DEFAULT_CHAT_BASE_URL = "https://provider.example.com/v1";
export const DEFAULT_CHAT_MODEL = "example-model";

export interface ChatModelConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

export interface ChatModelStatus {
  enabled: boolean;
  configured: boolean;
}

export async function getChatModelStatus(): Promise<ChatModelStatus> {
  const settings = await db.chatSettings.findUnique({
    where: { id: "default" },
    select: { enabled: true, encryptedApiKey: true, encryptionKeyVersion: true },
  });
  return {
    enabled: settings?.enabled ?? false,
    configured: Boolean(settings?.encryptedApiKey && settings.encryptionKeyVersion),
  };
}

export async function resolveChatModelConfig(): Promise<ChatModelConfig> {
  const settings = await db.chatSettings.findUnique({ where: { id: "default" } });
  if (!settings?.enabled) throw new Error("Chat is disabled");
  if (!settings.encryptedApiKey || !settings.encryptionKeyVersion) {
    throw new Error("Chat API credentials are not configured");
  }

  return {
    apiKey: decryptChatApiKey({
      id: settings.id,
      encryptedApiKey: settings.encryptedApiKey,
      encryptionKeyVersion: settings.encryptionKeyVersion,
    }),
    baseURL: normalizeChatBaseUrl(settings.baseUrl),
    model: normalizeChatModel(settings.model),
  };
}

export function normalizeChatBaseUrl(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2_000) {
    throw new Error("The AI provider base URL must contain 1 to 2,000 characters.");
  }
  const url = new URL(trimmed);
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const allowsHttp = env.NODE_ENV !== "production" && isLoopback;
  if (
    (url.protocol !== "https:" && !allowsHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("The AI provider base URL must use HTTPS without credentials, query, or hash.");
  }
  return url.toString().replace(/\/$/u, "");
}

export function normalizeChatModel(value: string): string {
  const model = value.trim();
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/u.test(model)) {
    throw new Error("The AI model must contain 1 to 200 characters without control characters.");
  }
  return model;
}

export function normalizeChatApiKey(value: string): string {
  const apiKey = value.trim();
  if (!apiKey || apiKey.length > 10_000 || /[\u0000-\u001f\u007f]/u.test(apiKey)) {
    throw new Error(
      "The AI API key must contain 1 to 10,000 characters without control characters.",
    );
  }
  return apiKey;
}
