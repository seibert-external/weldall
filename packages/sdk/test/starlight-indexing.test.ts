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
    expect(stripMarkdown("# Team\n\nWe **list** [employees](https://x.dev).")).toBe(
      "Team We list employees.",
    );
    expect(stripMarkdown("```\nweldall request x\n```\ntext")).toBe("text");
  });
});

describe("buildIndexFromDir", () => {
  it("indexes frontmatter title/description and English-stemmed content", async () => {
    const dir = await fixtureDocs({
      "team/overview.md": `---
title: Team
description: Employee directory and team structure.
---
The directory lists employees and explains the team structure.
`,
      "finance/reports-and-numbers.md": `---
title: Revenue reports
description: Revenue figures and internal dashboards.
---
Revenue figures and financial reports are available in internal dashboards.
`,
      "index.md": `---
title: Welcome
---
The Example Company knowledge base.
`,
    });

    const built = await buildIndexFromDir(dir, "english");
    expect(built.documents).toHaveLength(3);
    expect(built.documents.map((d) => d.path).sort()).toEqual([
      "/",
      "/finance/reports-and-numbers/",
      "/team/overview/",
    ]);

    const db = await readIndexFile(await persist(built));
    const byTerm = async (term: string) => (await runSearch(db, term, 10)).map((hit) => hit.path);

    // English stemming: singular queries match plural document terms.
    expect(await byTerm("employee")).toContain("/team/overview/");
    expect(await byTerm("employees")).toContain("/team/overview/");
    expect(await byTerm("the")).toEqual([]);
    expect(await byTerm("revenue")).toContain("/finance/reports-and-numbers/");
    expect(await byTerm("report")).toContain("/finance/reports-and-numbers/");
    expect(await byTerm("dashboards")).toContain("/finance/reports-and-numbers/");

    const hits = await runSearch(db, "revenue", 10);
    expect(hits[0]).toMatchObject({
      path: "/finance/reports-and-numbers/",
      title: "Revenue reports",
      description: "Revenue figures and internal dashboards.",
    });
    expect(typeof hits[0]!.score).toBe("number");
    expect(hits[0]!.excerpt).toContain("Revenue figures");
  });

  it("uses the configured language analyzer", async () => {
    const dir = await fixtureDocs({
      "team.md":
        "---\ntitle: Team\n---\nDas Mitarbeiterverzeichnis beschreibt alle Mitarbeitenden.\n",
    });
    const built = await buildIndexFromDir(dir, "german");
    const db = await readIndexFile(await persist(built, "german"));

    expect((await runSearch(db, "Mitarbeiterverzeichnis", 10))[0]?.path).toBe("/team/");
  });

  it("handles a missing content directory as an empty index", async () => {
    const built = await buildIndexFromDir(path.join(tmpdir(), "does-not-exist-xyz"));
    expect(built.documents).toHaveLength(0);
  });
});

async function persist(
  built: { raw: unknown; documents: unknown[] },
  language: "english" | "german" = "english",
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sws-index-"));
  tempDirs.push(dir);
  const file = path.join(dir, "index.json");
  await writeIndexFile(file, { language, raw: built.raw });
  return file;
}
