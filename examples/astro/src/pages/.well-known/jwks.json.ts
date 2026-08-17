import type { APIRoute } from "astro";
import { weldall } from "../../weldall";
export const prerender = false;
export const GET: APIRoute = (context) => weldall.handlers.jwks(context);
export const OPTIONS = GET;
