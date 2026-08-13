import { iacRoute } from "@/server/iac/http";
import { importIac } from "@/server/iac/service";
export const POST = (request: Request) =>
  iacRoute(request, (body, actor) => importIac(body, actor));
