export const APPEARANCE_FIELDS = [
  "icon",
  "brandIcon",
  "gradientFrom",
  "gradientTo",
  "darkGradientFrom",
  "darkGradientTo",
] as const;

export type AppearanceField = (typeof APPEARANCE_FIELDS)[number];
export type AppearanceValues = Record<AppearanceField, string>;

const recognizedAppearanceKeys = new Set<string>(APPEARANCE_FIELDS);

export function appearanceValuesFrom(appearance?: Record<string, string>): AppearanceValues {
  return Object.fromEntries(
    APPEARANCE_FIELDS.map((field) => [field, appearance?.[field] ?? ""]),
  ) as AppearanceValues;
}

/**
 * Builds the skill meta the form saves. Appearance keys the form does not know are kept as
 * they are; known keys come from the form, and empty values are left out.
 */
export function skillMetaFromForm(
  tags: string,
  owner: string,
  appearanceFields: Record<string, string>,
  existingAppearance?: Record<string, string>,
) {
  const appearance = {
    ...Object.fromEntries(
      Object.entries(existingAppearance ?? {}).filter(
        ([key]) => !recognizedAppearanceKeys.has(key),
      ),
    ),
    ...Object.fromEntries(Object.entries(appearanceFields).filter(([, value]) => value !== "")),
  };
  if (tags === "" && owner === "" && Object.keys(appearance).length === 0) return undefined;
  return {
    ...(tags !== "" ? { tags: tags.split("\n") } : {}),
    ...(owner !== "" ? { owner } : {}),
    ...(Object.keys(appearance).length ? { appearance } : {}),
  };
}
