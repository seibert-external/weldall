import { createDpopProof } from "@weldall/sdk";
import { CONFIG_REFRESH_HINT, type WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { isRecord, successfulResponse } from "../http.js";
import { withAccess } from "./auth.js";

export interface ClientPolicyResponse {
  version: 1;
  policy: Record<string, unknown>;
  updatedAt: string | null;
  etag: string;
}

export async function getClientPolicy(config: WeldallConfig): Promise<ClientPolicyResponse> {
  const url = `${config.issuer}/api/me/policy`;
  return withAccess(config, async (session) => {
    const proof = await createDpopProof({
      ...session.credentials,
      method: "GET",
      url,
      accessToken: session.accessToken,
    });
    const value = await successfulResponse(
      await fetch(url, {
        headers: {
          accept: "application/json",
          authorization: `DPoP ${session.accessToken}`,
          dpop: proof,
        },
        redirect: "error",
      }),
      "Weldall client policy request",
      CONFIG_REFRESH_HINT,
    );
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !isRecord(value.policy) ||
      value.policy.version !== 1 ||
      typeof value.etag !== "string" ||
      (value.updatedAt !== null && typeof value.updatedAt !== "string")
    ) {
      throw new CliError("Weldall returned an invalid client policy");
    }
    return {
      version: 1,
      policy: value.policy,
      updatedAt: value.updatedAt,
      etag: value.etag,
    };
  });
}
