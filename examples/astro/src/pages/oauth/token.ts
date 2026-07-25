import type { APIRoute } from "astro";
import { weldall } from "../../weldall";
export const prerender = false;
export const POST: APIRoute = (context) => weldall.handlers.token(context);
