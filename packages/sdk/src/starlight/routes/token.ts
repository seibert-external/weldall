import type { APIRoute } from "astro";
import { getRuntime } from "../runtime.js";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const runtime = await getRuntime();
  return runtime.weldall.handlers.token(context);
};
