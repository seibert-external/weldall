import type { APIRoute } from "astro";
import { getRuntime } from "../runtime.js";

export const prerender = false;

/**
 * Per-path protected-resource metadata for the `/api` scope. Public discovery
 * endpoint, mirroring the SDK's metadata handler.
 */
export const GET: APIRoute = async (context) => {
  const runtime = await getRuntime();
  return runtime.weldall.handlers.protectedResourceMetadata(context);
};
