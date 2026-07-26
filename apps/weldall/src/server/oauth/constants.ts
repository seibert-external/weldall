const LOCAL_WELDALL_ISSUER = "https://weldall.seibert.localdev";

export function resolveWeldallIssuer(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.WELDALL_ISSUER?.trim();
  const deploymentMode =
    env.WELDALL_DEPLOYMENT_MODE ?? (env.NODE_ENV === "production" ? "production" : "development");
  if (!configured && deploymentMode === "production") {
    throw new Error("WELDALL_ISSUER is required in production");
  }

  const issuer = new URL(configured || LOCAL_WELDALL_ISSUER);
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.pathname !== "/" ||
    issuer.search ||
    issuer.hash
  ) {
    throw new Error("WELDALL_ISSUER must be an HTTPS origin without credentials");
  }
  return issuer.origin;
}

export const WELDALL_ISSUER = resolveWeldallIssuer();
export const WELDALL_RESOURCE = `${WELDALL_ISSUER}/api`;
export const WELDALL_TOKEN_ENDPOINT = `${WELDALL_ISSUER}/api/auth/oauth2/token`;
export const WELDALL_REVOCATION_ENDPOINT = `${WELDALL_ISSUER}/api/auth/oauth2/revoke`;
export const WELDALL_CLIENT_ID = "weldall-cli";
