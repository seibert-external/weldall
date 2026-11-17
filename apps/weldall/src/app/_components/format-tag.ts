// Display-only: tags stay lowercase in data, filters, and URLs.
export function formatTagLabel(tag: string): string {
  return tag.charAt(0).toLocaleUpperCase() + tag.slice(1);
}
