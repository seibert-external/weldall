export const SKILL_CATALOG_SCHEMA_VERSION = 1 as const;
export const SKILL_CATALOG_PATH = "/.well-known/weldall-skills" as const;
export const SKILL_ASSERTION_TYPE = "weldall-skills+jwt" as const;
export const SKILL_TAG_LIMIT = 20 as const;
export const SKILL_TAG_LENGTH_LIMIT = 40 as const;

export type SkillVisibility = "DEFAULT" | "HIDDEN_IF_UNALLOWED";

export interface SkillMeta {
  tags?: string[];
  owner?: string;
  appearance?: Record<string, string>;
}

export interface PublishedSkill {
  id: string;
  title: string;
  requiredScopes: string[];
  visibility: SkillVisibility;
  content: string;
  meta?: SkillMeta;
  lastUpdatedAt?: string;
}

export interface SkillCatalog {
  schemaVersion: typeof SKILL_CATALOG_SCHEMA_VERSION;
  resource: string;
  skills: PublishedSkill[];
}

export type SkillProvider =
  | { items: readonly PublishedSkill[] }
  | {
      load: () => readonly PublishedSkill[] | Promise<readonly PublishedSkill[]>;
    };

const LOCAL_SKILL_ID = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const GLOBAL_SCOPE = /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/;
const VISIBILITIES = new Set<SkillVisibility>(["DEFAULT", "HIDDEN_IF_UNALLOWED"]);
const CATALOG_KEYS = new Set(["schemaVersion", "resource", "skills"]);
const SKILL_KEYS = new Set([
  "id",
  "title",
  "requiredScopes",
  "visibility",
  "content",
  "meta",
  "lastUpdatedAt",
]);
const SKILL_META_KEYS = new Set(["tags", "owner", "appearance"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => allowed.has(key));

export function parseSkillCatalog(value: unknown, expectedResource?: string): SkillCatalog {
  if (!isRecord(value) || !hasExactKeys(value, CATALOG_KEYS)) {
    throw new TypeError("invalid skill catalog");
  }
  if (value.schemaVersion !== SKILL_CATALOG_SCHEMA_VERSION) {
    throw new TypeError("unsupported skill catalog schema version");
  }
  if (
    typeof value.resource !== "string" ||
    (expectedResource && value.resource !== expectedResource)
  ) {
    throw new TypeError("skill catalog resource mismatch");
  }
  if (!Array.isArray(value.skills) || value.skills.length > 100) {
    throw new TypeError("skill catalog must contain at most 100 skills");
  }
  const ids = new Set<string>();
  const skills = value.skills.map((candidate): PublishedSkill => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, SKILL_KEYS)) {
      throw new TypeError("invalid published skill");
    }
    const { id, title, requiredScopes, visibility, content, meta, lastUpdatedAt } = candidate;
    if (typeof id !== "string" || id.length > 120 || !LOCAL_SKILL_ID.test(id) || ids.has(id)) {
      throw new TypeError("published skill IDs must be unique valid local IDs");
    }
    ids.add(id);
    if (typeof title !== "string" || title.length < 1 || title.length > 200) {
      throw new TypeError("published skill title must contain 1 to 200 characters");
    }
    if (typeof content !== "string" || content.length < 1 || content.length > 100_000) {
      throw new TypeError("published skill content must contain 1 to 100000 characters");
    }
    if (!Array.isArray(requiredScopes) || requiredScopes.length > 100) {
      throw new TypeError("published skill must require at most 100 scopes");
    }
    const scopes = requiredScopes.map((scope) => {
      if (typeof scope !== "string" || !GLOBAL_SCOPE.test(scope)) {
        throw new TypeError("published skill contains an invalid global scope");
      }
      return scope;
    });
    if (new Set(scopes).size !== scopes.length) {
      throw new TypeError("published skill scopes must be unique");
    }
    if (typeof visibility !== "string" || !VISIBILITIES.has(visibility as SkillVisibility)) {
      throw new TypeError("published skill visibility is invalid");
    }
    if (
      meta !== undefined &&
      (!isRecord(meta) ||
        !hasExactKeys(meta, SKILL_META_KEYS) ||
        (meta.tags !== undefined &&
          (!Array.isArray(meta.tags) ||
            meta.tags.length > SKILL_TAG_LIMIT ||
            !meta.tags.every(
              (tag) =>
                typeof tag === "string" && tag.length > 0 && tag.length <= SKILL_TAG_LENGTH_LIMIT,
            ))) ||
        (meta.owner !== undefined && typeof meta.owner !== "string") ||
        (meta.appearance !== undefined &&
          (!isRecord(meta.appearance) ||
            !Object.values(meta.appearance).every((value) => typeof value === "string"))))
    ) {
      throw new TypeError("published skill meta is invalid");
    }
    if (lastUpdatedAt !== undefined && typeof lastUpdatedAt !== "string") {
      throw new TypeError("published skill lastUpdatedAt is invalid");
    }
    return {
      id,
      title,
      requiredScopes: scopes,
      visibility: visibility as SkillVisibility,
      content,
      ...(meta !== undefined ? { meta: meta as SkillMeta } : {}),
      ...(lastUpdatedAt !== undefined ? { lastUpdatedAt } : {}),
    };
  });
  return {
    schemaVersion: SKILL_CATALOG_SCHEMA_VERSION,
    resource: value.resource,
    skills,
  };
}

export async function loadSkillCatalog(
  provider: SkillProvider,
  resource: string,
): Promise<SkillCatalog> {
  const items = "items" in provider ? provider.items : await provider.load();
  const catalog: SkillCatalog = {
    schemaVersion: SKILL_CATALOG_SCHEMA_VERSION,
    resource,
    skills: [...items],
  };
  const encoded = JSON.stringify(catalog);
  if (new TextEncoder().encode(encoded).byteLength > 1_048_576) {
    throw new TypeError("skill catalog exceeds 1 MiB");
  }
  return parseSkillCatalog(JSON.parse(encoded), resource);
}
