"use client";

import { useMemo, useRef, useState, type CSSProperties } from "react";
import { Button } from "@astryxdesign/core/Button";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { BrandIconOption } from "@/server/skills/brand-icons";
import { SkillIconTile } from "../../_components/skill-icon-tile";
import {
  brandGradient,
  gradientFromColor,
  isHexColor,
  relativeLuminance,
  SKILL_COLOR_SWATCHES,
  type SkillGradient,
} from "../../_components/skill-gradient";
import type { AppearanceValues } from "./skill-meta";

type IconFilter = "all" | "icons" | "brands";

interface PickerItem {
  kind: "icon" | "brand";
  key: string;
  label: string;
  search: string;
  hex?: string;
}

const PAGE_SIZE = 120;
const GRADIENT_FIELDS = [
  "gradientFrom",
  "gradientTo",
  "darkGradientFrom",
  "darkGradientTo",
] as const;

const lucideIconUrl = (name: string) => `/api/lucide-icons/${encodeURIComponent(name)}`;
const brandIconUrl = (slug: string) => `/api/brand-icons/${encodeURIComponent(slug)}`;

export function SkillAppearancePicker({
  seed,
  values,
  onChange,
  isReadOnly,
  iconOptions,
  iconTags,
  brandOptions,
}: {
  seed: string;
  values: AppearanceValues;
  onChange: (next: Partial<AppearanceValues>) => void;
  isReadOnly: boolean;
  iconOptions: string[];
  iconTags: Record<string, string>;
  brandOptions: BrandIconOption[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<IconFilter>("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // Colours in place before a brand was chosen, restored when the admin goes back to an icon.
  const gradientBeforeBrand = useRef<Partial<AppearanceValues> | null>(null);

  const brandsBySlug = useMemo(
    () => new Map(brandOptions.map((brand) => [brand.slug, brand])),
    [brandOptions],
  );
  const allItems = useMemo<PickerItem[]>(
    () => [
      ...iconOptions.map((name) => ({
        kind: "icon" as const,
        key: name,
        label: name,
        search: `${name} ${iconTags[name] ?? ""}`.toLocaleLowerCase(),
      })),
      ...brandOptions.map((brand) => ({
        kind: "brand" as const,
        key: brand.slug,
        label: brand.title,
        search: `${brand.slug} ${brand.title}`.toLocaleLowerCase(),
        hex: brand.hex,
      })),
    ],
    [brandOptions, iconOptions, iconTags],
  );
  const items = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const terms = normalizedQuery.split(/\s+/u).filter(Boolean);
    const matches = allItems.filter(
      (item) =>
        (filter === "all" || (filter === "icons" ? item.kind === "icon" : item.kind === "brand")) &&
        terms.every((term) => item.search.includes(term)),
    );
    if (!normalizedQuery) return matches;
    const rank = (item: PickerItem) => {
      const label = item.label.toLocaleLowerCase();
      return label === normalizedQuery || item.key === normalizedQuery
        ? 2
        : label.startsWith(normalizedQuery)
          ? 1
          : 0;
    };
    return [...matches].sort((a, b) => rank(b) - rank(a));
  }, [allItems, filter, query]);

  const brand = values.brandIcon ? brandsBySlug.get(values.brandIcon) : undefined;
  const isBrand = values.brandIcon !== "";
  const currentGradient = gradientOf(values);
  const selectedSwatch = currentGradient
    ? SKILL_COLOR_SWATCHES.find((swatch) =>
        sameGradient(gradientFromColor(swatch.color), currentGradient),
      )
    : undefined;
  const hasCustomGradient = !isBrand && currentGradient !== undefined && !selectedSwatch;
  const isColorLocked = isReadOnly || isBrand;
  const appearance = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
  const previewIconUrl = values.brandIcon
    ? brandIconUrl(values.brandIcon)
    : values.icon
      ? lucideIconUrl(values.icon)
      : undefined;
  const previewBrand = brand ? { hex: brand.hex } : undefined;

  const resetPaging = () => setVisibleCount(PAGE_SIZE);
  const chooseIcon = (name: string) => {
    if (isBrand) {
      onChange({ icon: name, brandIcon: "", ...(gradientBeforeBrand.current ?? emptyGradient()) });
      gradientBeforeBrand.current = null;
      return;
    }
    onChange({ icon: name });
  };
  const chooseBrand = (option: BrandIconOption) => {
    if (!isBrand) gradientBeforeBrand.current = pickGradient(values);
    // `icon` stays untouched so clients without brand support keep their current icon.
    onChange({ brandIcon: option.slug, ...gradientValues(brandGradient(option.hex)) });
  };

  return (
    <div className="skill-appearance-picker">
      <div className="skill-appearance-picker-main">
        <TextInput
          hasClear
          isDisabled={isReadOnly}
          label="Icon"
          onChange={(value) => {
            setQuery(value);
            resetPaging();
          }}
          placeholder="Search icons and brands, for example hubspot, mail or report"
          value={query}
          width="100%"
        />
        <div className="skill-appearance-picker-filter">
          <SegmentedControl
            label="Icon type"
            onChange={(value) => {
              setFilter(value as IconFilter);
              resetPaging();
            }}
            value={filter}
          >
            <SegmentedControlItem label="All" value="all" />
            <SegmentedControlItem label="Icons" value="icons" />
            <SegmentedControlItem label="Brands" value="brands" />
          </SegmentedControl>
          <Text color="secondary" size="sm">
            {query || filter !== "all"
              ? `${items.length} ${items.length === 1 ? "match" : "matches"}`
              : `${iconOptions.length} icons and ${brandOptions.length} brands`}
          </Text>
        </div>
        <div className="skill-appearance-browser">
          <div
            aria-label="Icons and brands"
            className="skill-appearance-grid"
            onScroll={(event) => {
              const grid = event.currentTarget;
              if (grid.scrollTop + grid.clientHeight > grid.scrollHeight - 200) {
                setVisibleCount((count) => Math.min(items.length, count + PAGE_SIZE));
              }
            }}
            role="group"
          >
            {items.length === 0 ? (
              <Text color="secondary" size="sm">
                No icons or brands match “{query}”.
              </Text>
            ) : (
              items.slice(0, visibleCount).map((item) => {
                const isSelected =
                  item.kind === "brand"
                    ? values.brandIcon === item.key
                    : !isBrand && values.icon === item.key;
                return (
                  <button
                    aria-label={item.label}
                    aria-pressed={isSelected}
                    className="skill-appearance-option"
                    disabled={isReadOnly}
                    key={`${item.kind}:${item.key}`}
                    onClick={() => {
                      if (item.kind === "icon") chooseIcon(item.key);
                      else {
                        const option = brandsBySlug.get(item.key);
                        if (option) chooseBrand(option);
                      }
                    }}
                    title={item.label}
                    type="button"
                  >
                    <span
                      className="skill-appearance-option-glyph"
                      data-brand={item.kind === "brand" ? "" : undefined}
                      style={glyphStyle(item)}
                    />
                    <span className="skill-appearance-option-label">{item.label}</span>
                  </button>
                );
              })
            )}
          </div>
          <aside aria-label="Preview" className="skill-appearance-preview">
            <span className="skill-appearance-colors-label">Preview</span>
            <div className="skill-appearance-preview-pair">
              <div className="skill-appearance-preview-mode" data-mode="light">
                <SkillIconTile
                  appearance={appearance}
                  brand={previewBrand}
                  iconUrl={previewIconUrl}
                  mode="light"
                  seed={seed || "new-skill"}
                  size={56}
                />
                Light
              </div>
              <div className="skill-appearance-preview-mode" data-mode="dark">
                <SkillIconTile
                  appearance={appearance}
                  brand={previewBrand}
                  iconUrl={previewIconUrl}
                  mode="dark"
                  seed={seed || "new-skill"}
                  size={56}
                />
                Dark
              </div>
            </div>
          </aside>
        </div>

        <div className="skill-appearance-colors">
          <span className="skill-appearance-colors-label" id="skill-appearance-color-label">
            Color
          </span>
          <div
            aria-labelledby="skill-appearance-color-label"
            className="skill-appearance-swatches"
            data-locked={isColorLocked || undefined}
            role="group"
          >
            {SKILL_COLOR_SWATCHES.map((swatch) => (
              <button
                aria-label={swatch.name}
                aria-pressed={!isBrand && selectedSwatch === swatch}
                className="skill-appearance-swatch"
                disabled={isColorLocked}
                key={swatch.name}
                onClick={() => onChange(gradientValues(gradientFromColor(swatch.color)))}
                style={{ background: swatch.color }}
                title={swatch.name}
                type="button"
              />
            ))}
            <label
              aria-pressed={hasCustomGradient}
              className="skill-appearance-swatch skill-appearance-swatch-custom"
              data-set={hasCustomGradient || undefined}
              style={
                hasCustomGradient && currentGradient
                  ? {
                      background: `linear-gradient(135deg, ${currentGradient.light[0]}, ${currentGradient.light[1]})`,
                    }
                  : undefined
              }
              title="Custom color"
            >
              <input
                aria-label="Choose a custom color"
                disabled={isColorLocked}
                onChange={(event) =>
                  onChange(gradientValues(gradientFromColor(event.target.value)))
                }
                type="color"
                value={currentGradient?.light[0] ?? "#5730cc"}
              />
            </label>
          </div>
          <Text color="secondary" size="sm">
            {colorHint(brand?.title, isBrand, hasCustomGradient, currentGradient !== undefined)}
          </Text>
        </div>

        <details className="skill-appearance-advanced">
          <summary>Advanced: edit gradient colors</summary>
          <div className="skill-appearance-advanced-fields">
            {GRADIENT_FIELDS.map((field) => (
              <TextInput
                isDisabled={isColorLocked}
                key={field}
                label={GRADIENT_LABELS[field]}
                onChange={(value) => onChange({ [field]: value })}
                placeholder="#5730CC"
                value={values[field]}
                width="100%"
              />
            ))}
          </div>
        </details>

        {!isReadOnly ? (
          <div>
            <Button
              label="Reset icons and colors"
              onClick={() => {
                gradientBeforeBrand.current = null;
                onChange({ icon: "", brandIcon: "", ...emptyGradient() });
              }}
              type="button"
              variant="secondary"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function colorHint(
  brandTitle: string | undefined,
  isBrand: boolean,
  hasCustomGradient: boolean,
  hasGradient: boolean,
): string {
  if (isBrand) {
    return `The color comes from the ${brandTitle ?? "selected"} brand and is fixed. The icon color adapts automatically.`;
  }
  if (hasCustomGradient) {
    return "Custom gradient. It is kept as it is until you choose another color.";
  }
  return hasGradient
    ? "The light and dark gradients are automatically generated from the selected color."
    : "Without a color, the skill gets an automatic Seibert gradient.";
}

const GRADIENT_LABELS: Record<(typeof GRADIENT_FIELDS)[number], string> = {
  gradientFrom: "Light gradient from",
  gradientTo: "Light gradient to",
  darkGradientFrom: "Dark gradient from",
  darkGradientTo: "Dark gradient to",
};

function glyphStyle(item: PickerItem): CSSProperties {
  const url = item.kind === "brand" ? brandIconUrl(item.key) : lucideIconUrl(item.key);
  const style: Record<string, string> = {
    maskImage: `url("${url}")`,
    WebkitMaskImage: `url("${url}")`,
  };
  if (item.hex) {
    // Brand colour in the grid unless it would vanish on the page background.
    const luminance = relativeLuminance(item.hex);
    style["--glyph-light"] = luminance > 0.6 ? "currentColor" : item.hex;
    style["--glyph-dark"] = luminance < 0.04 ? "currentColor" : item.hex;
  }
  return style as CSSProperties;
}

function gradientOf(values: AppearanceValues): SkillGradient | undefined {
  if (!isHexColor(values.gradientFrom) || !isHexColor(values.gradientTo)) return undefined;
  const light = [values.gradientFrom, values.gradientTo] as const;
  const dark =
    isHexColor(values.darkGradientFrom) && isHexColor(values.darkGradientTo)
      ? ([values.darkGradientFrom, values.darkGradientTo] as const)
      : light;
  return { light, dark };
}

function sameGradient(a: SkillGradient, b: SkillGradient): boolean {
  return [...a.light, ...a.dark].every(
    (value, index) => value.toLowerCase() === [...b.light, ...b.dark][index]?.toLowerCase(),
  );
}

function gradientValues(gradient: SkillGradient): Partial<AppearanceValues> {
  return {
    gradientFrom: gradient.light[0],
    gradientTo: gradient.light[1],
    darkGradientFrom: gradient.dark[0],
    darkGradientTo: gradient.dark[1],
  };
}

function pickGradient(values: AppearanceValues): Partial<AppearanceValues> {
  return Object.fromEntries(GRADIENT_FIELDS.map((field) => [field, values[field]]));
}

function emptyGradient(): Partial<AppearanceValues> {
  return Object.fromEntries(GRADIENT_FIELDS.map((field) => [field, ""]));
}
