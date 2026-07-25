import { weldall } from "../../../weldall";

export const runtime = "nodejs";
export const GET = weldall.withWeldall({ scopes: ["expenses:read"] }, async (_request, auth) =>
  Response.json({ subject: auth.identity.subject }),
);
