import { iacRoute } from "@/server/iac/http";
import { unmanageRequestSchema } from "@/server/iac/contracts";
import { unmanageIac } from "@/server/iac/service";
export const POST = (request: Request) =>
  iacRoute(request, (body, actor) => unmanageIac(unmanageRequestSchema.parse(body), actor));
