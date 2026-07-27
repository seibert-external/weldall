import * as astroPlugin from "prettier-plugin-astro";

/** @type {import('prettier').Config} */
export default {
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  printWidth: 100,
  plugins: [astroPlugin],
  overrides: [{ files: "*.astro", options: { parser: "astro" } }],
};
