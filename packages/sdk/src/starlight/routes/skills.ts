import type { APIRoute } from "astro";
import { getRuntime } from "../runtime.js";

export const prerender = false;

/**
 * Skill-catalog endpoint at `/.well-known/weldall-skills`, consumed by the
 * Weldall platform for auto-discovery of the published `search` skill. The
 * catalog itself is protected by a skill assertion issued by the platform.
 */
export const GET: APIRoute = async (context) => {
  const runtime = await getRuntime();
  return runtime.weldall.handlers.skills(context);
};
