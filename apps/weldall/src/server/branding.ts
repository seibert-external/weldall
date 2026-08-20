import { db } from "@weldall/db";

export interface CliLogoUrls {
  light: string;
  dark: string;
}

export async function getEffectiveCliLogoUrls(): Promise<CliLogoUrls> {
  const settings = await db.cliSettings.findUnique({
    where: { id: "default" },
    select: { logoUrl: true, darkLogoUrl: true },
  });
  const light = safelyParseCliLogoUrl(settings?.logoUrl);
  const dark = safelyParseCliLogoUrl(settings?.darkLogoUrl);
  return { light: light || dark, dark: dark || light };
}

function safelyParseCliLogoUrl(value: string | null | undefined): string {
  try {
    return parseCliLogoUrl(value);
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
