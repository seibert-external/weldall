import { iacRoute } from "@/server/iac/http";
import { importRequestSchema } from "@/server/iac/contracts";
import { importIac } from "@/server/iac/service";
export const POST = (request: Request) =>
  iacRoute(request, (body, actor) => importIac(importRequestSchema.parse(body), actor));
