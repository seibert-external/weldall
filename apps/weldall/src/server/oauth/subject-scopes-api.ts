import { SUBJECT_SCOPES_CHECK_SCOPE_KEY } from "@weldall/db";
import { WeldallAuthError } from "@weldall/sdk";
import { z } from "zod";
import { checkSubjectScopesForMachine, SubjectScopeCheckError } from "../policy/resources";
import { scopeKeySchema } from "../policy/scope-key";
import { loggedOauthErrorResponse } from "./error-response";
import { authenticateWeldallMachineApiRequest } from "./machine-api";

const MAX_BODY_BYTES = 16_000;
const bodySchema = z
  .object({
    subject: z
      .string()
      .min(1)
      .max(191)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
    scopes: z.array(scopeKeySchema).min(1).max(100),
  })
  .strict()
  .refine(({ scopes }) => new Set(scopes).size === scopes.length, {
    message: "scopes must be unique",
    path: ["scopes"],
  });

async function requestBody(request: Request): Promise<z.infer<typeof bodySchema>> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new WeldallAuthError("invalid_request", "JSON content type required");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new WeldallAuthError("invalid_request", "request body is too large");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new WeldallAuthError("invalid_request", "request body is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new WeldallAuthError("invalid_request", "invalid JSON body");
  }
  const parsed = bodySchema.safeParse(value);
  if (!parsed.success) {
    throw new WeldallAuthError("invalid_request", "subject and unique valid scopes are required");
  }
  return parsed.data;
}

export async function subjectScopesCheck(request: Request): Promise<Response> {
  try {
    const actor = await authenticateWeldallMachineApiRequest(
      request,
      SUBJECT_SCOPES_CHECK_SCOPE_KEY,
    );
    const body = await requestBody(request);
    const result = await checkSubjectScopesForMachine({
      clientId: actor.clientId,
      subject: body.subject,
      scopes: body.scopes,
    });
    return Response.json(
      { ...result, evaluatedAt: new Date().toISOString() },
      { headers: { "cache-control": "no-store", pragma: "no-cache" } },
    );
  } catch (error) {
    if (error instanceof SubjectScopeCheckError) {
      if (error.code === "FORBIDDEN") {
        return loggedOauthErrorResponse(
          new WeldallAuthError(
            "insufficient_scope",
            "machine is not allowed to check one or more requested scopes",
            403,
          ),
        );
      }
      if (error.code === "NOT_FOUND") {
        return loggedOauthErrorResponse(
          new WeldallAuthError("not_found", "subject was not found", 404),
        );
      }
      const response = loggedOauthErrorResponse(
        new WeldallAuthError(
          "temporarily_unavailable",
          "scope assignments cannot be evaluated authoritatively",
          503,
        ),
      );
      response.headers.set("retry-after", "30");
      return response;
    }
    return loggedOauthErrorResponse(error);
  }
}
