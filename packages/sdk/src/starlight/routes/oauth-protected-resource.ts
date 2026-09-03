import type { APIRoute } from "astro";
import { getRuntime } from "../runtime.js";

export const prerender = false;

/**
 * Root resource metadata endpoint. Exposes the resource identifier, the
 * supported scopes, and the skill-catalog endpoint so Weldall can discover
 * this resource. Public (discovery) endpoint.
 */
export const GET: APIRoute = async (context) => {
  const runtime = await getRuntime();
  return runtime.weldall.handlers.protectedResourceMetadata(context);
};
