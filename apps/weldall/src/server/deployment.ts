import { db } from "@weldall/db";
import { decryptProviderToken } from "./group-providers/credentials";
import { WELDALL_RESOURCE } from "./oauth/constants";

const LOCAL_WELDALL_RESOURCE = "https://weldall.seibert.localdev/api";
const LOCAL_EXPENSES_RESOURCE = "https://expenses.seibert.localdev/api";

export async function prepareProductionDatabase(): Promise<void> {
  if (WELDALL_RESOURCE === LOCAL_WELDALL_RESOURCE) return;

  await db.$transaction(async (tx) => {
    const [seededResource, productionResource] = await Promise.all([
      tx.oauthResource.findUnique({ where: { id: "weldall-api" } }),
      tx.oauthResource.findUnique({ where: { identifier: WELDALL_RESOURCE } }),
    ]);

    if (seededResource?.identifier === LOCAL_WELDALL_RESOURCE) {
      if (productionResource && productionResource.id !== seededResource.id) {
        await tx.oauthResource.delete({ where: { id: seededResource.id } });
      } else {
        await tx.oauthResource.update({
          where: { id: seededResource.id },
          data: { identifier: WELDALL_RESOURCE, updatedAt: new Date() },
        });
      }
    }

    await tx.downstreamResource.updateMany({
      where: {
        id: "downstream-resource-expenses",
        resourceIdentifier: LOCAL_EXPENSES_RESOURCE,
        enabled: true,
      },
      data: {
        enabled: false,
        version: { increment: 1 },
        updatedBy: "deployment-bootstrap",
      },
    });
  });

  const providers = await db.groupProvider.findMany({
    select: { id: true, encryptedToken: true, encryptionKeyVersion: true },
  });
  for (const provider of providers) decryptProviderToken(provider);
}
