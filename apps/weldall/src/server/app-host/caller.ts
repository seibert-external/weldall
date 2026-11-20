import { APP_HOST_SCOPE_KEY, db } from "@weldall/db";
import { WeldallAuthError } from "@weldall/sdk";
import type { z } from "zod";
import {
  authenticateWeldallMachineApiRequest,
  type WeldallMachineActor,
} from "../oauth/machine-api";

/**
 * Authentication and resource binding for the app host API (`/api/app-host/v1`), used by a Git
 * app: a separate service registered in Weldall as a resource. The caller is a machine client
 * with the machine-only system scope `weldall:app-host` and names its resource identifier in
 * every request. The machine client must be allowed for that resource (`MachineAllowedResource`,
 * the same selection that lets it request tokens for the resource) and the resource must be
 * enabled. Every entry the API writes is recorded against that resource.
 */

export interface AppHostResource {
  id: string;
  key: string;
  resourceIdentifier: string;
}

const MAX_BODY_BYTES = 64_000;

/** The calling machine client, authenticated with `weldall:app-host`. */
export async function authenticateAppHost(request: Request): Promise<WeldallMachineActor> {
  return authenticateWeldallMachineApiRequest(request, APP_HOST_SCOPE_KEY);
}

/**
 * The resource the machine client acts for. An unknown resource, one the client is not allowed
 * for and a disabled one are refused alike, so the answer reveals nothing about other resources.
 */
export async function appHostResource(
  machine: WeldallMachineActor,
  resourceIdentifier: string,
): Promise<AppHostResource> {
  const allowed = await db.machineAllowedResource.findFirst({
    where: { machineClientId: machine.id, resource: { resourceIdentifier } },
    select: {
      resource: { select: { id: true, key: true, resourceIdentifier: true, enabled: true } },
    },
  });
  if (!allowed?.resource.enabled)
    throw new WeldallAuthError(
      "invalid_target",
      "machine client is not allowed for this resource or the resource is disabled",
      403,
    );
  const { enabled: _enabled, ...resource } = allowed.resource;
  return resource;
}

/** Reads a bounded JSON body and validates it against `schema`; any mismatch is `400 invalid_request`. */
export async function appHostRequestBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json")
    throw new WeldallAuthError("invalid_request", "JSON content type required");
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES)
    throw new WeldallAuthError("invalid_request", "request body is too large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES)
    throw new WeldallAuthError("invalid_request", "request body is too large");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new WeldallAuthError("invalid_request", "invalid JSON body");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new WeldallAuthError(
      "invalid_request",
      `request body does not match the contract (${where}${issue?.message ?? "invalid"})`,
    );
  }
  return parsed.data;
}

/** The person a Git app acts for, by Weldall user id; only verified accounts count. */
export async function appHostSubject(subject: string) {
  const user = await db.user.findUnique({
    where: { id: subject },
    select: { id: true, email: true, emailVerified: true },
  });
  if (!user?.emailVerified)
    throw new WeldallAuthError("unknown_subject", "subject is not a Weldall user", 404);
  return { id: user.id, email: user.email };
}
