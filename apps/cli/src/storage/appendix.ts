import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { withLock } from "./lock.js";

const CACHE_VERSION = 1;
const MAX_APPENDIX_LENGTH = 100_000;
const MAX_PREVIEW_ITEMS = 10_000;

export interface CachedSkillPreview {
  slug: string;
  title: string;
  available: boolean;
  tags?: string[];
  owner?: string;
  sourceKey?: string;
  sourceName?: string;
}

export interface CliHeaderSnapshot {
  appendix: string;
  scopes: string[];
  skills: CachedSkillPreview[];
  skillsInitialized?: boolean;
  subject?: string;
}

interface CachedAppendix extends CliHeaderSnapshot {
  version: typeof CACHE_VERSION;
  issuer: string;
}

const cacheName = (issuer: string) =>
  `appendix-${createHash("sha256").update(issuer).digest("base64url")}.json`;

const validStrings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_PREVIEW_ITEMS &&
  value.every((item) => typeof item === "string");

const validSkills = (value: unknown): value is CachedSkillPreview[] =>
  Array.isArray(value) &&
  value.length <= MAX_PREVIEW_ITEMS &&
  value.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Partial<CachedSkillPreview>).slug === "string" &&
      typeof (item as Partial<CachedSkillPreview>).title === "string" &&
      typeof (item as Partial<CachedSkillPreview>).available === "boolean" &&
      ((item as Partial<CachedSkillPreview>).tags === undefined ||
        validStrings((item as Partial<CachedSkillPreview>).tags)) &&
      ((item as Partial<CachedSkillPreview>).owner === undefined ||
        typeof (item as Partial<CachedSkillPreview>).owner === "string") &&
      ((item as Partial<CachedSkillPreview>).sourceKey === undefined ||
        typeof (item as Partial<CachedSkillPreview>).sourceKey === "string") &&
      ((item as Partial<CachedSkillPreview>).sourceName === undefined ||
        typeof (item as Partial<CachedSkillPreview>).sourceName === "string"),
  );

export class AppendixCache {
  constructor(private readonly directory = join(homedir(), ".weldall")) {}

  async readSnapshot(issuer: string): Promise<CliHeaderSnapshot | null> {
    try {
      const value = JSON.parse(
        await readFile(join(this.directory, cacheName(issuer)), "utf8"),
      ) as Partial<CachedAppendix> | null;
      if (
        value?.version !== CACHE_VERSION ||
        value.issuer !== issuer ||
        typeof value.appendix !== "string" ||
        value.appendix.length > MAX_APPENDIX_LENGTH ||
        (value.subject !== undefined &&
          (typeof value.subject !== "string" || !value.subject.trim())) ||
        (value.scopes !== undefined && !validStrings(value.scopes)) ||
        (value.skills !== undefined && !validSkills(value.skills)) ||
        (value.skillsInitialized !== undefined && typeof value.skillsInitialized !== "boolean")
      )
        return null;
      const skills = value.skills ?? [];
      const snapshot = {
        appendix: value.appendix,
        scopes: value.scopes ?? [],
        skills,
        skillsInitialized: value.skillsInitialized ?? skills.length > 0,
        ...(value.subject === undefined ? {} : { subject: value.subject }),
      };
      return snapshot;
    } catch {
      return null;
    }
  }

  async readSnapshotForSubject(
    issuer: string,
    subject: string | null,
  ): Promise<CliHeaderSnapshot | null> {
    const snapshot = await this.readSnapshot(issuer);
    if (!snapshot || !subject || snapshot.subject !== subject)
      return snapshot ? { ...snapshot, scopes: [], skills: [], skillsInitialized: false } : null;
    return snapshot;
  }

  async read(issuer: string): Promise<string | null> {
    return (await this.readSnapshot(issuer))?.appendix ?? null;
  }

  async writeSnapshot(issuer: string, snapshot: CliHeaderSnapshot): Promise<void> {
    if (
      snapshot.appendix.length > MAX_APPENDIX_LENGTH ||
      !validStrings(snapshot.scopes) ||
      !validSkills(snapshot.skills) ||
      (snapshot.skillsInitialized !== undefined &&
        typeof snapshot.skillsInitialized !== "boolean") ||
      (snapshot.subject !== undefined && !snapshot.subject.trim())
    )
      return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, cacheName(issuer));
    const temporary = join(this.directory, `.appendix-${randomUUID()}.tmp`);
    const value: CachedAppendix = { version: CACHE_VERSION, issuer, ...snapshot };
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    try {
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async updateSnapshot(
    issuer: string,
    patch: Partial<CliHeaderSnapshot>,
  ): Promise<CliHeaderSnapshot> {
    const lockPath = join(
      this.directory,
      `.appendix-${createHash("sha256").update(issuer).digest("base64url")}`,
    );
    return withLock(
      async () => {
        const current: CliHeaderSnapshot = (await this.readSnapshot(issuer)) ?? {
          appendix: "",
          scopes: [],
          skills: [],
          skillsInitialized: false,
        };
        const subjectChanged = patch.subject !== undefined && patch.subject !== current.subject;
        const next: CliHeaderSnapshot = {
          appendix: patch.appendix ?? current.appendix,
          scopes: patch.scopes ?? (subjectChanged ? [] : current.scopes),
          skills: patch.skills ?? (subjectChanged ? [] : current.skills),
          skillsInitialized:
            patch.skillsInitialized ??
            (subjectChanged ? false : (current.skillsInitialized ?? false)),
          ...(patch.subject === undefined
            ? current.subject === undefined
              ? {}
              : { subject: current.subject }
            : { subject: patch.subject }),
        };
        await this.writeSnapshot(issuer, next);
        return next;
      },
      {
        path: lockPath,
        retries: { retries: 20, factor: 1.1, minTimeout: 10, maxTimeout: 100 },
      },
    );
  }

  async write(issuer: string, appendix: string): Promise<void> {
    const current = await this.readSnapshot(issuer);
    await this.writeSnapshot(issuer, {
      appendix,
      scopes: current?.scopes ?? [],
      skills: current?.skills ?? [],
      skillsInitialized: current?.skillsInitialized ?? false,
      ...(current?.subject === undefined ? {} : { subject: current.subject }),
    });
  }
}

export const appendixCache = new AppendixCache();
