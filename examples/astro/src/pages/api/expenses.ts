import type { APIRoute } from "astro";
import { weldall } from "../../weldall";

export const prerender = false;
export const GET: APIRoute = (context) =>
  Response.json({ subject: weldall.getAuth(context).identity.subject });
export const OPTIONS = weldall.preflight(["GET"], "/api/expenses");
