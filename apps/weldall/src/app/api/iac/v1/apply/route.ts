import { iacRoute } from "@/server/iac/http";
import { applyIac } from "@/server/iac/service";
export const POST = (request: Request) => iacRoute(request, (body, actor) => applyIac(body, actor));
