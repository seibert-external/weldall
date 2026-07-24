import { db } from "@weldall/db";
import { normalizeEmail } from "../admin/service";

export interface VisibleSkill {
  slug: string;
  title: string;
  requiredScopes: string[];
  hidden: boolean;
  available: boolean;
  missingScopes: string[];
  updatedAt: string;
}

export interface VisibleSkillDetail extends VisibleSkill {
  content: string;
  document: string;
}

export async function listVisibleSkills(email: string): Promise<VisibleSkill[]> {
  const [skills, grants] = await Promise.all([
    db.skill.findMany({ orderBy: [{ title: "asc" }, { slug: "asc" }] }),
    db.emailScopeGrant.findMany({
      where: { assignment: { normalizedEmail: normalizeEmail(email) } },
      select: { scope: { select: { key: true } } },
    }),
  ]);
  const grantedScopes = new Set(grants.map((grant) => grant.scope.key));
  return skills
    .map((skill) => skillVisibility(skill, grantedScopes))
    .filter((skill) => !skill.hidden || skill.available);
}

export async function getVisibleSkill(
  email: string,
  slug: string,
): Promise<VisibleSkillDetail | null> {
  const [skill, grants] = await Promise.all([
    db.skill.findUnique({ where: { slug } }),
    db.emailScopeGrant.findMany({
      where: { assignment: { normalizedEmail: normalizeEmail(email) } },
      select: { scope: { select: { key: true } } },
    }),
  ]);
  if (!skill) return null;
  const metadata = skillVisibility(skill, new Set(grants.map((grant) => grant.scope.key)));
  if (metadata.hidden && !metadata.available) return null;
  return {
    ...metadata,
    content: skill.content,
    document: renderSkillDocument({
      title: skill.title,
      requiredScopes: metadata.requiredScopes,
      hidden: skill.hidden,
      content: skill.content,
    }),
  };
}

function skillVisibility(
  skill: {
    slug: string;
    title: string;
    requiredScopes: string[];
    hidden: boolean;
    updatedAt: Date;
  },
  grantedScopes: ReadonlySet<string>,
): VisibleSkill {
  const requiredScopes = [...new Set(skill.requiredScopes)].sort();
  const missingScopes = requiredScopes.filter((scope) => !grantedScopes.has(scope));
  return {
    slug: skill.slug,
    title: skill.title,
    requiredScopes,
    hidden: skill.hidden,
    available: missingScopes.length === 0,
    missingScopes,
    updatedAt: skill.updatedAt.toISOString(),
  };
}

export function renderSkillDocument(input: {
  title: string;
  requiredScopes: string[];
  hidden: boolean;
  content: string;
}): string {
  const scopeLines = input.requiredScopes.length
    ? ["requiredScopes:", ...input.requiredScopes.map((scope) => `  - ${JSON.stringify(scope)}`)]
    : ["requiredScopes: []"];
  return [
    "---",
    `title: ${JSON.stringify(input.title)}`,
    ...scopeLines,
    `hidden: ${input.hidden ? "true" : "false"}`,
    "---",
    "",
    input.content.trim(),
    "",
  ].join("\n");
}
