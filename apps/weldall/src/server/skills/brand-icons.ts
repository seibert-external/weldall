import * as simpleIcons from "simple-icons";
import type { SimpleIcon } from "simple-icons";

export interface BrandIconOption {
  slug: string;
  title: string;
  hex: string;
}

export interface BrandIcon extends BrandIconOption {
  path: string;
}

const brandIconsBySlug = new Map<string, SimpleIcon>(
  Object.values(simpleIcons)
    .filter(
      (icon): icon is SimpleIcon => typeof icon === "object" && icon !== null && "slug" in icon,
    )
    .map((icon) => [icon.slug, icon]),
);

/** Every brand the skill form offers, sorted by name, without the SVG paths. */
export const brandIconOptions: BrandIconOption[] = [...brandIconsBySlug.values()]
  .map(({ slug, title, hex }) => ({ slug, title, hex: `#${hex.toLowerCase()}` }))
  .sort((a, b) => a.title.localeCompare(b.title, "en"));

export function resolveBrandIcon(slug: string | undefined): BrandIcon | undefined {
  if (!slug) return undefined;
  const icon = brandIconsBySlug.get(slug);
  return icon
    ? { slug: icon.slug, title: icon.title, hex: `#${icon.hex.toLowerCase()}`, path: icon.path }
    : undefined;
}
