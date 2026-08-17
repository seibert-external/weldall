export { createBrowserDpopProof, calculateJkt, normalizeHtu } from "./dpop.js";
export {
  WeldallBrowserError,
  WeldallBrowserUnsupportedError,
  type WeldallBrowserErrorCode,
} from "./errors.js";
export { inspectWeldallBrowserSupport, requireWeldallBrowserSupport } from "./support.js";
export {
  WELDALL_BROWSER_CAPABILITY_CODES,
  type WeldallBrowserCapabilityCode,
  type WeldallBrowserClient,
  type WeldallBrowserClientOptions,
  type WeldallBrowserSupport,
  type WeldallConnectMethod,
  type WeldallConnectionStatus,
  type WeldallPendingConnection,
  type WeldallRequestOptions,
} from "./types.js";

import { WeldallBrowserClientImpl } from "./client.js";
import { requireWeldallBrowserSupport } from "./support.js";
import type { WeldallBrowserClient, WeldallBrowserClientOptions } from "./types.js";

export async function createWeldallBrowserClient(
  options: WeldallBrowserClientOptions,
): Promise<WeldallBrowserClient> {
  await requireWeldallBrowserSupport();
  return new WeldallBrowserClientImpl(options);
}
