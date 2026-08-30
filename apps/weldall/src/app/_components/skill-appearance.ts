export type SkillAppearance = Record<string, string>;
export type SkillAppearanceIconNode = Array<
  [
    element: "circle" | "ellipse" | "g" | "line" | "path" | "polygon" | "polyline" | "rect",
    attributes: Record<string, string>,
  ]
>;

interface SkillGradient {
  light: readonly [string, string];
  dark: readonly [string, string];
}

export interface ResolvedSkillAppearance extends SkillGradient {
  fallbackIconNode: SkillAppearanceIconNode;
}

import { corporateGradients } from "./corporate-palette";

// Auto gradients drawn from the Seibert corporate identity palette (pine-green,
// teal-green, lake-teal, lilac, lavender, apple-green) so every skill resolves to
// an on-brand accent even without an explicit appearance. Selections are
// deterministic per slug/tag via stableIndex.
const skillGradients: readonly SkillGradient[] = Object.values(corporateGradients).map(
  (gradient) => ({ light: gradient.light, dark: gradient.dark }),
);

// Lucide 1.25.0 nodes kept client-local so tag and fallback icons do not pull the full catalog.
const fallbackIconNodes = [
  [
    [
      "path",
      {
        d: "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z",
        key: "1s2grr",
      },
    ],
    ["path", { d: "M20 2v4", key: "1rf3ol" }],
    ["path", { d: "M22 4h-4", key: "gwowj6" }],
    ["circle", { cx: "4", cy: "20", r: "2", key: "6kqj1y" }],
  ],
  [
    ["path", { d: "M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16", key: "jecpp" }],
    ["rect", { width: "20", height: "14", x: "2", y: "6", rx: "2", key: "i6l2r4" }],
  ],
  [
    ["path", { d: "M3 3v16a2 2 0 0 0 2 2h16", key: "c24i48" }],
    ["path", { d: "M18 17V9", key: "2bz60n" }],
    ["path", { d: "M13 17V5", key: "1frdt8" }],
    ["path", { d: "M8 17v-3", key: "17ska0" }],
  ],
  [
    [
      "path",
      {
        d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
        key: "1oefj6",
      },
    ],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5", key: "wfsgrz" }],
    ["path", { d: "M10 9H8", key: "b1mrlr" }],
    ["path", { d: "M16 13H8", key: "t4e002" }],
    ["path", { d: "M16 17H8", key: "z1uh3a" }],
  ],
  [
    ["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", key: "1yyitq" }],
    ["path", { d: "M16 3.128a4 4 0 0 1 0 7.744", key: "16gr8j" }],
    ["path", { d: "M22 21v-2a4 4 0 0 0-3-3.87", key: "kshegd" }],
    ["circle", { cx: "9", cy: "7", r: "4", key: "nufk8" }],
  ],
  [
    [
      "path",
      {
        d: "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z",
        key: "1xq2db",
      },
    ],
  ],
  [
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
    ["path", { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", key: "13o1zl" }],
    ["path", { d: "M2 12h20", key: "9i4pu4" }],
  ],
  [
    [
      "path",
      {
        d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
        key: "oel41y",
      },
    ],
    ["path", { d: "m9 12 2 2 4-4", key: "dzmm74" }],
  ],
] as SkillAppearanceIconNode[];

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

export function resolveSkillAppearance(
  seed: string,
  appearance?: Readonly<SkillAppearance>,
): ResolvedSkillAppearance {
  const fallback = skillGradients[stableIndex(seed, skillGradients.length)] ?? skillGradients[0]!;
  const light = resolveGradientPair(
    appearance?.gradientFrom,
    appearance?.gradientTo,
    fallback.light,
  );
  const dark = resolveGradientPair(
    appearance?.darkGradientFrom,
    appearance?.darkGradientTo,
    fallback.dark,
  );
  const fallbackIconNode =
    fallbackIconNodes[stableIndex(seed, fallbackIconNodes.length)] ?? fallbackIconNodes[0]!;

  return { light, dark, fallbackIconNode };
}

function resolveGradientPair(
  from: string | undefined,
  to: string | undefined,
  fallback: readonly [string, string],
): readonly [string, string] {
  return from && to && HEX_COLOR.test(from) && HEX_COLOR.test(to) ? [from, to] : fallback;
}

function stableIndex(value: string, length: number): number {
  let hash = 0;
  for (const character of value) hash = Math.imul(31, hash) + character.codePointAt(0)!;
  return (hash >>> 0) % length;
}
