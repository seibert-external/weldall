import {
  authenticateConnectorActor,
  createConnectorErrorResponse,
  createJsonResponse,
} from "@/server/connectors/http";
import { listOwnApps } from "@/server/app-registry/registry";

/**
 * Lists the CLI caller's apps from the app registry with their re-verification state
 * (`active`, `expiring_soon`, `expired`), expired and expiring ones first. Read-only; the Git app
 * that keeps an app's repository creates the entry.
 */
export async function GET(request: Request) {
  try {
    const actor = await authenticateConnectorActor({ request });
    return createJsonResponse(await listOwnApps(actor));
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}
