import { createDpopProof } from "@weldall/sdk";
import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { isRecord, successfulResponse } from "../http.js";
import { withLock } from "../storage/lock.js";
import { withAccess } from "./auth.js";

export async function getCliAppendix(config: WeldallConfig): Promise<string> {
  return withLock(() =>
    withAccess(config, async (session) => {
      const proof = await createDpopProof({
        ...session.credentials,
        method: "GET",
        url: config.cli,
        accessToken: session.accessToken,
      });
      const value = await successfulResponse(
        await fetch(config.cli, {
          headers: {
            accept: "application/json",
            authorization: `DPoP ${session.accessToken}`,
            dpop: proof,
          },
          redirect: "error",
        }),
        "Weldall CLI settings request",
      );
      if (!isRecord(value) || typeof value.appendix !== "string") {
        throw new CliError("Weldall returned invalid CLI settings");
      }
      return value.appendix;
    }),
  );
}
