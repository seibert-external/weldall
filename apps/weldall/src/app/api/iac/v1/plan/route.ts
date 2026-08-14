import { iacRoute } from "@/server/iac/http";
import { planRequestSchema } from "@/server/iac/contracts";
import { planIac } from "@/server/iac/service";
export const POST = (request: Request) =>
  iacRoute(request, (body, actor) => planIac(planRequestSchema.parse(body).manifest, actor));
