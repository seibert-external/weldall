const optionalPlaceholder = "<<insert or delete line>>";
const present = (value: string | undefined) => {
  const normalized = value?.trim();
  return normalized && normalized !== optionalPlaceholder ? normalized : undefined;
};

export type WeldallDeploymentMode = "development" | "e2e" | "production";

export function resolveDeploymentMode(env: NodeJS.ProcessEnv = process.env): WeldallDeploymentMode {
  const deploymentMode =
    present(env.WELDALL_DEPLOYMENT_MODE) ??
    (env.NODE_ENV === "production" ? "production" : "development");
  if (!new Set(["development", "e2e", "production"]).has(deploymentMode)) {
    throw new Error("WELDALL_DEPLOYMENT_MODE must be development, e2e or production");
  }
  return deploymentMode as WeldallDeploymentMode;
}

export type LoginProviderConfiguration = {
  google?: { clientId: string; clientSecret: string };
  devOidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
  };
};

export function resolveLoginProviders(
  env: NodeJS.ProcessEnv = process.env,
): LoginProviderConfiguration {
  const googleClientId = present(env.GOOGLE_CLIENT_ID);
  const googleClientSecret = present(env.GOOGLE_CLIENT_SECRET);
  if (Boolean(googleClientId) !== Boolean(googleClientSecret))
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together");

  const deploymentMode = resolveDeploymentMode(env);
  const devLoginEnabled = env.ENABLE_DEV_LOGIN === "true";
  if (devLoginEnabled && deploymentMode === "production")
    throw new Error("ENABLE_DEV_LOGIN must not be enabled in production");

  const google =
    googleClientId && googleClientSecret
      ? { clientId: googleClientId, clientSecret: googleClientSecret }
      : undefined;
  let devOidc: LoginProviderConfiguration["devOidc"];
  if (devLoginEnabled) {
    const issuer = present(env.DEV_IDP_ISSUER);
    const clientId = present(env.DEV_IDP_CLIENT_ID);
    const clientSecret = present(env.DEV_IDP_CLIENT_SECRET);
    if (!issuer || !clientId || !clientSecret)
      throw new Error(
        "DEV_IDP_ISSUER, DEV_IDP_CLIENT_ID and DEV_IDP_CLIENT_SECRET are required when ENABLE_DEV_LOGIN=true",
      );
    const parsedIssuer = new URL(issuer);
    if (
      parsedIssuer.protocol !== "https:" ||
      parsedIssuer.username ||
      parsedIssuer.password ||
      parsedIssuer.pathname !== "/" ||
      parsedIssuer.search ||
      parsedIssuer.hash
    )
      throw new Error("DEV_IDP_ISSUER must be an HTTPS origin without credentials");
    devOidc = { issuer: parsedIssuer.origin, clientId, clientSecret };
  }

  if (!google && !devOidc) throw new Error("at least one login provider must be configured");
  return { ...(google ? { google } : {}), ...(devOidc ? { devOidc } : {}) };
}
