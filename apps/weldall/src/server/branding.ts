import { db } from "@weldall/db";

export async function getEffectiveCliLogoUrl(): Promise<string> {
  const settings = await db.cliSettings.findUnique({
    where: { id: "default" },
    select: { logoUrl: true },
  });
  try {
    return parseCliLogoUrl(settings?.logoUrl);
  } catch {
    return "";
  }
}

export function parseCliLogoUrl(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  if (trimmed.length > 2_000) throw new TypeError("Logo URL must be 2,000 characters or less.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TypeError("Logo URL must be an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new TypeError("Logo URL must be HTTPS without credentials.");
  return url.toString();
}
