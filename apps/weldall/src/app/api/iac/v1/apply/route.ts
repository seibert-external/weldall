import { iacRoute } from "@/server/iac/http";
import { applyRequestSchema } from "@/server/iac/contracts";
import { applyIac } from "@/server/iac/service";
export const POST = (request: Request) =>
  iacRoute(request, (body, actor) => applyIac(applyRequestSchema.parse(body), actor));
