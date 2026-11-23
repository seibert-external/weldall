import type { CSSProperties } from "react";
import { SkillAppearanceIcon } from "./skill-appearance-icon";
import {
  resolveSkillAppearance,
  type SkillAppearance,
  type SkillAppearanceIconNode,
} from "./skill-appearance";
import {
  brandGradient,
  iconColorFor,
  isHexColor,
  needsDarkRing,
  SKILL_ICON_LIGHT,
} from "./skill-gradient";

export interface SkillTileBrand {
  hex: string;
  /** SVG path of the logo; without it the logo is drawn from `iconUrl`. */
  path?: string | undefined;
}

/**
 * The small icon box of a skill. Order: brand logo (`brandIcon`), then the Lucide `icon`,
 * then the existing slug-based fallback. Stored gradients always win; a brand without
 * stored gradients uses its exact brand colour. Only brand tiles adapt the icon colour.
 */
export function SkillIconTile({
  seed,
  appearance,
  iconNode,
  iconUrl,
  brand,
  size = 40,
  mode,
  className,
}: {
  seed: string;
  appearance?: Readonly<SkillAppearance> | undefined;
  iconNode?: SkillAppearanceIconNode | undefined;
  /** An SVG URL drawn as a mask, used where icon data is not loaded (the skill form). */
  iconUrl?: string | undefined;
  brand?: SkillTileBrand | undefined;
  size?: number;
  /** Forces light or dark colours, for side-by-side previews. */
  mode?: "light" | "dark" | undefined;
  className?: string | undefined;
}) {
  const resolved = resolveSkillAppearance(seed, appearance);
  const brandColors = brand ? brandGradient(brand.hex) : undefined;
  const light =
    brandColors && !hasPair(appearance?.gradientFrom, appearance?.gradientTo)
      ? brandColors.light
      : resolved.light;
  const dark =
    brandColors && !hasPair(appearance?.darkGradientFrom, appearance?.darkGradientTo)
      ? brandColors.dark
      : resolved.dark;

  const style = {
    "--tile-size": `${size}px`,
    "--tile-light-from": light[0],
    "--tile-light-to": light[1],
    "--tile-dark-from": dark[0],
    "--tile-dark-to": dark[1],
    "--tile-fg-light": brand ? iconColorFor(light) : SKILL_ICON_LIGHT,
    "--tile-fg-dark": brand ? iconColorFor(dark) : SKILL_ICON_LIGHT,
    "--tile-ring": needsDarkRing(dark) ? "rgb(255 255 255 / 22%)" : "transparent",
  } as CSSProperties;

  return (
    <span
      aria-hidden="true"
      className={["skill-icon-tile", className].filter(Boolean).join(" ")}
      data-brand={brand ? "" : undefined}
      data-mode={mode}
      style={style}
    >
      {brand?.path ? (
        <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d={brand.path} />
        </svg>
      ) : iconUrl ? (
        <span
          className="skill-icon-tile-mask"
          style={{ maskImage: `url("${iconUrl}")`, WebkitMaskImage: `url("${iconUrl}")` }}
        />
      ) : (
        <SkillAppearanceIcon
          appearance={appearance}
          iconNode={iconNode}
          seed={seed}
          strokeWidth={2.25}
        />
      )}
    </span>
  );
}

function hasPair(from: string | undefined, to: string | undefined): boolean {
  return isHexColor(from) && isHexColor(to);
}
