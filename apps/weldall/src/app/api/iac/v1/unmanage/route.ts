import { iacRoute } from "@/server/iac/http";
import { unmanageIac } from "@/server/iac/service";
export const POST = (request: Request) =>
  iacRoute(request, (body, actor) => unmanageIac(body, actor));
