export const WELDALL_BROWSER_CAPABILITY_CODES = [
  "secure-context",
  "crypto-subtle",
  "p256-key-generation",
  "non-exportable-private-key",
  "public-jwk-export",
  "p256-signing",
  "indexeddb",
  "indexeddb-cryptokey-clone",
  "fetch",
  "url",
  "text-encoder",
  "abort-controller",
  "crypto-random",
  "navigator-locks",
] as const;

export type WeldallBrowserCapabilityCode = (typeof WELDALL_BROWSER_CAPABILITY_CODES)[number];

export type WeldallBrowserSupport =
  | { supported: true; missingFeatures: []; testedFeatures: WeldallBrowserCapabilityCode[] }
  | {
      supported: false;
      missingFeatures: WeldallBrowserCapabilityCode[];
      testedFeatures: WeldallBrowserCapabilityCode[];
    };

export type WeldallConnectionStatus =
  | { state: "disconnected"; verified: "local" | "remote" }
  | {
      state: "connected";
      verified: "local" | "remote";
      connectionId: string;
      origin: string;
      resource: string;
      subject?: string;
    }
  | {
      state: "invalid";
      verified: "local" | "remote";
      reason: "corrupt-storage" | "missing-key" | "expired" | "revoked" | "origin-changed";
    };

export type WeldallConnectMethod = "cli-code" | "browser-oauth" | "auto";

export type WeldallPendingConnection = {
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  connected: Promise<Extract<WeldallConnectionStatus, { state: "connected" }>>;
};

export type WeldallBrowserClientOptions = {
  issuer: string;
  resource: string;
  fetch?: typeof globalThis.fetch;
};

export type WeldallRequestOptions = Omit<RequestInit, "redirect" | "credentials"> & {
  scopes: string[];
};

export interface WeldallBrowserClient {
  connect(options?: {
    method?: WeldallConnectMethod;
    signal?: AbortSignal;
  }): Promise<WeldallPendingConnection>;
  getConnectionStatus(options?: {
    verify?: "local" | "remote";
    signal?: AbortSignal;
  }): Promise<WeldallConnectionStatus>;
  request(input: string | URL, options: WeldallRequestOptions): Promise<Response>;
  disconnect(options?: { signal?: AbortSignal }): Promise<void>;
  clearLocalConnection(): Promise<void>;
}
