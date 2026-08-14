import { iacRoute } from "@/server/iac/http";
import { moveRequestSchema } from "@/server/iac/contracts";
import { moveIacState } from "@/server/iac/service";
export const POST = (request: Request) =>
  iacRoute(request, (body, actor) => moveIacState(moveRequestSchema.parse(body), actor));
