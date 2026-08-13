import { iacRoute } from "@/server/iac/http";
import { moveIacState } from "@/server/iac/service";
export const POST = (request: Request) =>
  iacRoute(request, (body, actor) => moveIacState(body, actor));
