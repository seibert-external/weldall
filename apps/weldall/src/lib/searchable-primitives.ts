export type SearchablePrimitiveType = "skill" | "resource" | "scope";

/** Minimal browser-search payload. Detail-only and authorization metadata stay server-side. */
export interface SearchablePrimitiveDto {
  type: SearchablePrimitiveType;
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  available?: boolean;
}
