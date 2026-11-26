export type GradientPair = readonly [string, string];

export interface SkillGradient {
  light: GradientPair;
  dark: GradientPair;
}

export const SKILL_ICON_LIGHT = "#ffffff";
export const SKILL_ICON_DARK = "#17171c";

interface Oklch {
  L: number;
  C: number;
  H: number;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

export function isHexColor(value: string | undefined): value is string {
  return value !== undefined && HEX_COLOR.test(value);
}

// Vivid preset colours that all keep a white icon at 3:1 contrast or more. Amber stands in
// for yellow, as a bright yellow cannot carry a white icon.
export const SKILL_COLOR_SWATCHES: readonly { name: string; color: string }[] = [
  { name: "Red", color: "#dc2626" },
  { name: "Orange", color: "#ea580c" },
  { name: "Amber", color: "#d97706" },
  { name: "Lime", color: "#65a30d" },
  { name: "Green", color: "#16a34a" },
  { name: "Teal", color: "#0d9488" },
  { name: "Sky", color: "#0284c7" },
  { name: "Blue", color: "#2563eb" },
  { name: "Indigo", color: "#4f46e5" },
  { name: "Violet", color: "#7c3aed" },
  { name: "Fuchsia", color: "#c026d3" },
  { name: "Pink", color: "#db2777" },
  { name: "Graphite", color: "#4b5563" },
];

/**
 * A gradient for a colour the admin picked. The colour is kept as it is when a white icon
 * reaches 3:1 on it and only darkened as far as needed otherwise; very dark colours are
 * lifted a little. The dark variant never drops below a level that still stands out from
 * a dark page.
 */
export function gradientFromColor(hex: string): SkillGradient {
  const color = hexToOklch(hex);
  let L = Math.max(0.42, color.L);
  while (L > 0.42 && contrastRatio(SKILL_ICON_LIGHT, oklchToHex({ ...color, L })) < 3) {
    L -= 0.01;
  }
  const start = L === color.L ? hex.toLowerCase() : oklchToHex({ L, C: color.C, H: color.H });
  return {
    light: [start, oklchToHex({ L: L + 0.12, C: color.C * 0.8, H: color.H + 14 })],
    dark: [
      oklchToHex({ L: Math.max(0.3, L - 0.18), C: color.C * 0.85, H: color.H }),
      oklchToHex({ L: Math.max(0.38, L - 0.05), C: color.C * 0.9, H: color.H + 10 }),
    ],
  };
}

/**
 * A gradient for a brand: the brand colour is used unchanged and only fades into a
 * slightly darker shade of the same hue, so it stays the lightest point of the tile.
 */
export function brandGradient(hex: string): SkillGradient {
  const color = hexToOklch(hex);
  const pair: GradientPair = [
    hex.toLowerCase(),
    oklchToHex({ L: Math.max(0.05, color.L - 0.07), C: color.C, H: color.H }),
  ];
  return { light: pair, dark: pair };
}

/** White whenever it reaches the WCAG minimum for graphics (3:1) on both stops, else dark. */
export function iconColorFor(pair: GradientPair): string {
  const onWhite = Math.min(
    contrastRatio(SKILL_ICON_LIGHT, pair[0]),
    contrastRatio(SKILL_ICON_LIGHT, pair[1]),
  );
  return onWhite >= 3 ? SKILL_ICON_LIGHT : SKILL_ICON_DARK;
}

/** Very dark tiles get a hairline ring on dark pages so they do not melt into the page. */
export function needsDarkRing(pair: GradientPair): boolean {
  return relativeLuminance(pair[0]) < 0.02;
}

export function relativeLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) =>
    toLinear(channel / 255),
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (high + 0.05) / (low + 0.05);
}

function hexToOklch(hex: string): Oklch {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = toLinear(((value >> 16) & 255) / 255);
  const g = toLinear(((value >> 8) & 255) / 255);
  const b = toLinear((value & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), H: (Math.atan2(B, A) * 180) / Math.PI };
}

function oklchToHex({ L, C, H }: Oklch): string {
  const hue = (H * Math.PI) / 180;
  const A = C * Math.cos(hue);
  const B = C * Math.sin(hue);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return `#${[
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
    .map((channel) => Math.round(clamp(toSrgb(clamp(channel, 0, 1)), 0, 1) * 255))
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function toSrgb(channel: number): number {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
