import type { APIRoute } from "astro";
import { getRuntime } from "../runtime.js";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const runtime = await getRuntime();
  return runtime.weldall.handlers.authorizationServerMetadata(context);
};
