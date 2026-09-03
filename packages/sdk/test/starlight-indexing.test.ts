import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildIndexFromDir,
  readIndexFile,
  routeFor,
  runSearch,
  stripMarkdown,
  writeIndexFile,
} from "../src/starlight/indexing.js";

let tempDirs: string[] = [];

async function fixtureDocs(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sws-docs-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("routeFor", () => {
  it("maps Starlight content paths to routes", () => {
    expect(routeFor("team/overview.md")).toBe("/team/overview/");
    expect(routeFor("index.md")).toBe("/");
    expect(routeFor("finance/reports-and-numbers.mdx")).toBe("/finance/reports-and-numbers/");
    expect(routeFor("team/index.md")).toBe("/team/");
  });
});

describe("stripMarkdown", () => {
  it("removes markdown and keeps plain words", () => {
    expect(stripMarkdown("# Team\n\nWir **zählen** [Mitarbeiter](https://x.dev).")).toBe(
      "Team Wir zählen Mitarbeiter.",
    );
    expect(stripMarkdown("```\nweldall request x\n```\ntext")).toBe("text");
  });
});

describe("buildIndexFromDir", () => {
  it("indexes frontmatter title/description and German-stemmed content", async () => {
    const dir = await fixtureDocs({
      "team/overview.md": `---
title: Team
description: Mitarbeiterverzeichnis und Teamstruktur.
---
Wir beschreiben den Aufbau des **Mitarbeiterverzeichnisses** und die Teamstruktur der Seibert Group.
`,
      "finance/reports-and-numbers.md": `---
title: Umsatzzahlen
description: BWA und Google Dashboards.
---
BWA, Umsatzzahlen und Google Dashboards.
`,
      "index.md": `---
title: Start
---
Die Grundlagen der Seibert Group.
`,
    });

    const built = await buildIndexFromDir(dir, "german");
    expect(built.documents).toHaveLength(3);
    expect(built.documents.map((d) => d.path).sort()).toEqual([
      "/",
      "/finance/reports-and-numbers/",
      "/team/overview/",
    ]);

    const db = await readIndexFile(await persist(built));
    const byTerm = async (term: string) => (await runSearch(db, term, 10)).map((hit) => hit.path);

    // German stemming: different inflections resolve to the same stem.
    expect(await byTerm("Mitarbeiter")).toContain("/team/overview/");
    expect(await byTerm("Mitarbeiterverzeichnis")).toContain("/team/overview/");
    expect(await byTerm("und")).toEqual([]);
    expect(await byTerm("umsatz")).toContain("/finance/reports-and-numbers/");
    expect(await byTerm("bwa")).toContain("/finance/reports-and-numbers/");
    expect(await byTerm("dashboards")).toContain("/finance/reports-and-numbers/");

    const hits = await runSearch(db, "umsatz", 10);
    expect(hits[0]).toMatchObject({
      path: "/finance/reports-and-numbers/",
      title: "Umsatzzahlen",
      description: "BWA und Google Dashboards.",
    });
    expect(typeof hits[0]!.score).toBe("number");
    expect(hits[0]!.excerpt).toContain("Umsatzzahlen");
  });

  it("handles a missing content directory as an empty index", async () => {
    const built = await buildIndexFromDir(path.join(tmpdir(), "does-not-exist-xyz"), "german");
    expect(built.documents).toHaveLength(0);
  });
});

async function persist(built: { raw: unknown; documents: unknown[] }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sws-index-"));
  tempDirs.push(dir);
  const file = path.join(dir, "index.json");
  await writeIndexFile(file, { language: "german", raw: built.raw });
  return file;
}
