import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@weldall/db";
import type { GroupProvider, LoginProvider } from "@prisma/client";
import type { DesiredState, IacBlocker } from "./contracts";
import { desiredObjects, type CurrentObject } from "./planner";
import { sharedConfigInclude } from "../connectors/core/shared-connections";
import { publicLoginProvider } from "../domain/secret-primitive-contracts";

/** Presence and public binding checks only: no decryption, upstream requests, or envelope I/O. */
export async function secretPrimitiveBlockers(input: {
  tx: Prisma.TransactionClient;
  manifest: DesiredState;
  objects: CurrentObject[];
  sharedConnections: Prisma.ConnectionGetPayload<{ include: typeof sharedConfigInclude }>[];
  groupProviders: GroupProvider[];
  loginProviders: LoginProvider[];
}): Promise<IacBlocker[]> {
  const { tx, manifest, objects, sharedConnections, groupProviders, loginProviders } = input;
  const desired = desiredObjects(manifest);
  const owned = objects.filter((o) => o.ownerWorkspaceId === manifest.workspace.id);
  const retained = objects.filter(
    (o) => o.ownerWorkspaceId !== manifest.workspace.id && !o.tombstone,
  );
  const final = [...retained, ...desired];
  const blockers: IacBlocker[] = [];
  if (
    Object.keys(manifest.loginProviders ?? {}).length &&
    (await tx.loginInstallation.findUnique({ where: { id: "default" } }))?.state !== "COMPLETED"
  )
    blockers.push({
      code: "SETUP_REQUIRED",
      message:
        "Complete the initial interactive login installation before managing login providers with IaC.",
    });
  const block = (address: string, code: string, message: string) =>
    blockers.push({ address, code, message });
  for (const [kind, section] of [
    ["sharedConnection", "sharedConnections"],
    ["groupProvider", "groupProviders"],
    ["loginProvider", "loginProviders"],
  ] as const)
    if (manifest[section] === undefined && owned.some((o) => o.kind === kind))
      block(
        "workspace",
        "CLIENT_UPGRADE_REQUIRED",
        `This workspace manages ${section}. Upgrade the CLI and explicitly include ${section} (an empty mapping explicitly removes them).`,
      );
  const currentFor = (address: string) => owned.find((o) => o.address === address && !o.tombstone);
  const users = await tx.user.findMany({
    where: {
      email: {
        in: Object.values(manifest.sharedConnections ?? {}).map((c) => c.credentialManagerEmail),
      },
    },
    select: { id: true, email: true },
  });
  for (const [name, config] of Object.entries(manifest.sharedConnections ?? {})) {
    const address = `sharedConnection.${name}`;
    const bound = currentFor(address);
    const row = sharedConnections.find((c) => c.id === bound?.id && c.key === config.key);
    const connector = final.find(
      (o) => o.kind === "connector" && o.identity === config.connectorKey,
    )?.state as { type?: string } | undefined;
    if (connector?.type !== "atlassian-mcp")
      block(
        address,
        "INVALID_CONNECTOR",
        "A configured Atlassian MCP connector is required (it may be disabled).",
      );
    if (!users.some((u) => u.email === config.credentialManagerEmail))
      block(
        address,
        "UNKNOWN_CUSTODIAN",
        "credentialManagerEmail must reference an existing user.",
      );
    if (
      row &&
      (row.connector.key !== config.connectorKey ||
        row.owner.email !== config.credentialManagerEmail)
    )
      block(address, "IMMUTABLE_BINDING", "Connector and credential manager cannot be reassigned.");
    if (row?.credentialId && !isDeepStrictEqual(row.providerSelection, config.provider))
      block(
        address,
        "CREDENTIAL_BINDING",
        "A credential cannot be rebound to a different account selection.",
      );
    if (config.enabled && !row?.credentialId)
      block(
        address,
        "MISSING_CREDENTIAL",
        "Create disabled, provision the credential in the UI, then explicitly enable.",
      );
    for (const key of config.useScopes)
      if (
        key.startsWith("weldall:") ||
        !final.some((o) => o.kind === "scope" && o.identity === key)
      )
        block(
          address,
          "INVALID_SCOPE",
          `Use scope ${key} must exist and must not be a system scope.`,
        );
  }
  for (const [name, config] of Object.entries(manifest.groupProviders ?? {})) {
    const address = `groupProvider.${name}`;
    const bound = currentFor(address);
    const row = groupProviders.find((p) => p.id === bound?.id && p.key === config.key);
    if (config.enabled && !row?.encryptedToken)
      block(address, "MISSING_CREDENTIAL", "Provision a token in the UI before enabling.");
    if (row && row.adapterType !== config.adapterType)
      block(address, "IMMUTABLE_PROVIDER", "Provider adapter cannot change.");
    if (row?.encryptedToken && row.baseUrl !== config.baseUrl)
      block(
        address,
        "CREDENTIAL_BINDING",
        "Changing the token destination requires UI reprovisioning.",
      );
  }
  for (const [name, config] of Object.entries(manifest.loginProviders ?? {})) {
    const address = `loginProvider.${name}`;
    const bound = currentFor(address);
    const row = loginProviders.find((p) => p.id === bound?.id && p.id === config.id);
    if (config.enabled && !row?.encryptedClientSecret)
      block(address, "MISSING_CREDENTIAL", "Provision a client secret in the UI before enabling.");
    if (row && row.issuer !== config.issuer)
      block(address, "IMMUTABLE_ISSUER", "An existing login provider's issuer cannot change.");
    if (
      row?.encryptedClientSecret &&
      (row.clientId !== config.clientId ||
        row.discoveryUrl !== (config.discoveryUrl ?? null) ||
        row.tokenEndpointAuthMethod !== config.tokenEndpointAuthMethod)
    )
      block(
        address,
        "CREDENTIAL_BINDING",
        "Changing the client or discovery endpoint requires UI reprovisioning.",
      );
  }
  const enabledBefore = loginProviders.filter((p) => p.enabled);
  if (
    enabledBefore.length &&
    !final.some(
      (o) =>
        o.kind === "loginProvider" && (o.state as ReturnType<typeof publicLoginProvider>).enabled,
    )
  )
    for (const provider of enabledBefore) {
      const target = owned.find((o) => o.kind === "loginProvider" && o.id === provider.id);
      if (target)
        block(
          target.address!,
          "LAST_LOGIN_PROVIDER",
          "IaC cannot disable or delete the last enabled login provider. Use the explicit UI/recovery workflow.",
        );
    }
  for (const object of final.filter((o) => o.kind === "groupAssignment")) {
    const providerKey = (object.state as { provider: string }).provider;
    if (!final.some((o) => o.kind === "groupProvider" && o.identity === providerKey))
      block(
        object.address ?? "workspace",
        "EXTERNAL_REFERENCE",
        `Group assignment still references provider ${providerKey}.`,
      );
  }
  const deletingConnectors = owned.filter(
    (o) =>
      o.kind === "connector" &&
      !o.tombstone &&
      !desired.some((d) => d.address === o.address && d.identity === o.identity),
  );
  for (const connector of deletingConnectors) {
    const rows = await tx.connection.findMany({
      where: { connectorId: connector.id },
      select: { id: true },
    });
    for (const row of rows) {
      const binding = owned.find((o) => o.kind === "sharedConnection" && o.id === row.id);
      if (!binding || desired.some((d) => d.address === binding.address))
        block(
          connector.address!,
          "EXTERNAL_REFERENCE",
          "Remove dependent connections explicitly; IaC cannot cascade into unmanaged or foreign connections.",
        );
    }
    if (await tx.connectionAuthorization.count({ where: { connectorId: connector.id } }))
      block(
        connector.address!,
        "EXTERNAL_REFERENCE",
        "Remove pending authorization attempts in the UI before deleting this connector.",
      );
  }
  return blockers;
}
