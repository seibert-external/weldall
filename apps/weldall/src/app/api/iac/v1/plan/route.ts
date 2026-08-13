import { iacRoute } from "@/server/iac/http";
import { planIac } from "@/server/iac/service";
export const POST = (request: Request) => iacRoute(request, (body) => planIac(body.manifest));
