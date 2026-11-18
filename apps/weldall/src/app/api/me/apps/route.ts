import { z } from "zod";
import {
  authenticateConnectorActor,
  createConnectorErrorResponse,
  createJsonResponse,
  parseJsonRequestBody,
} from "@/server/connectors/http";
import { createAppRepository } from "@/server/app-registry/repositories";
import { listOwnApps } from "@/server/app-registry/registry";

const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\u0000-\u001f\u007f]*$/);

/**
 * Lists the CLI caller's apps from the app registry with their re-verification state
 * (`active`, `expiring_soon`, `expired`), expired and expiring ones first. Read-only.
 */
export async function GET(request: Request) {
  try {
    const actor = await authenticateConnectorActor({ request });
    return createJsonResponse(await listOwnApps(actor));
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}

/**
 * Creates the repository for the CLI caller's new app from a connector template and registers
 * the app for them. Repeating the call resumes with the same repository. The Git host's token
 * stays on the server.
 */
export async function POST(request: Request) {
  try {
    const actor = await authenticateConnectorActor({ request });
    const input = await parseJsonRequestBody({
      request,
      schema: z
        .object({
          connector: z.string().max(120).optional(),
          template: z.string().max(100),
          name: z.string().max(100),
          purpose: text(300),
        })
        .strict(),
    });
    return createJsonResponse(await createAppRepository({ actor, input, signal: request.signal }));
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}
