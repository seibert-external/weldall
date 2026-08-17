import type { WeldallBrowserCapabilityCode } from "./types.js";

export type WeldallBrowserErrorCode =
  | "unsupported-browser"
  | "connection-required"
  | "permission-denied"
  | "origin-rejected"
  | "resource-disabled"
  | "key-loss"
  | "refresh-replay"
  | "cors"
  | "network"
  | "connection-denied"
  | "connection-expired"
  | "invalid-response"
  | "unsupported-strategy";

export class WeldallBrowserError extends Error {
  constructor(
    readonly code: WeldallBrowserErrorCode,
    message: string,
    readonly recovery: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WeldallBrowserError";
  }
}

export class WeldallBrowserUnsupportedError extends WeldallBrowserError {
  readonly missingFeatures: WeldallBrowserCapabilityCode[];
  constructor(missingFeatures: WeldallBrowserCapabilityCode[]) {
    super(
      "unsupported-browser",
      `This browser cannot securely store a Weldall connection (${missingFeatures.join(", ")}).`,
      "Use a current supported browser in a normal HTTPS window. Private browsing modes may disable durable key storage.",
    );
    this.name = "WeldallBrowserUnsupportedError";
    this.missingFeatures = [...missingFeatures];
  }
}
