/**
 * Shared gradient accents drawn from the Seibert corporate identity palette.
 * All nav highlights, hero gradients, and skill auto-colors resolve from these
 * on-brand pairs (pine-green / teal-green / lake-teal / lilac / lavender /
 * apple-green) so the whole app stays within brand instead of a rainbow.
 */
export type CorporateGradient = {
  light: readonly [string, string];
  dark: readonly [string, string];
};

const brand = {
  pine700: "rgb(2, 52, 62)", // #02343E
  pine600: "rgb(2, 70, 75)", // #02464B
  pine500: "rgb(27, 89, 93)", // #1B595D
  teal: "rgb(9, 133, 119)", // #098577
  lake500: "rgb(40, 172, 155)", // #28AC9B
  lake400: "rgb(98, 197, 174)", // #62C5AE
  apple: "rgb(190, 230, 0)", // #BEE600
  darkLilac: "rgb(30, 15, 75)", // #1E0F4B
  lilac: "rgb(87, 48, 204)", // #5730CC
  lavender500: "rgb(97, 106, 209)", // #616AD1
  lavender400: "rgb(130, 139, 226)", // #828BE2
  lavender300: "rgb(156, 163, 236)", // #9CA3EC
} as const;

const darken = {
  pine700: "rgb(1, 26, 32)",
  pine600: "rgb(1, 35, 39)",
  pine500: "rgb(13, 46, 49)",
  teal: "rgb(4, 67, 58)",
  lake500: "rgb(20, 86, 80)",
  lake400: "rgb(49, 99, 87)",
  apple: "rgb(95, 115, 0)",
  darkLilac: "rgb(15, 7, 38)",
  lilac: "rgb(44, 24, 102)",
  lavender500: "rgb(49, 53, 106)",
  lavender400: "rgb(65, 70, 113)",
  lavender300: "rgb(78, 82, 118)",
} as const;

export const corporateGradients = {
  pine: { light: [brand.pine700, brand.pine500], dark: [darken.pine700, darken.pine500] },
  pineTeal: { light: [brand.pine600, brand.lake500], dark: [darken.pine600, darken.lake500] },
  teal: { light: [brand.teal, brand.lake500], dark: [darken.teal, darken.lake500] },
  lake: { light: [brand.lake500, brand.lake400], dark: [darken.lake500, darken.lake400] },
  pineApple: { light: [brand.pine500, brand.apple], dark: [darken.pine500, darken.apple] },
  darkLilac: { light: [brand.darkLilac, brand.lilac], dark: [darken.darkLilac, darken.lilac] },
  lilac: { light: [brand.lilac, brand.lavender500], dark: [darken.lilac, darken.lavender500] },
  lavender: {
    light: [brand.lavender500, brand.lavender400],
    dark: [darken.lavender500, darken.lavender400],
  },
  lavenderLight: {
    light: [brand.lavender400, brand.lavender300],
    dark: [darken.lavender400, darken.lavender300],
  },
} as const satisfies Record<string, CorporateGradient>;
