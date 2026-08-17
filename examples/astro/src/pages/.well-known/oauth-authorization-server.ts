import type { APIRoute } from "astro";
import { weldall } from "../../weldall";
export const prerender = false;
export const GET: APIRoute = (context) => weldall.handlers.authorizationServerMetadata(context);
export const OPTIONS = GET;
