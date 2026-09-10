import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");

export const FRONTMATTER = {
  name: "weldall",
  description:
    "Use when the request concerns a company system, a business record, or an action on one, such as contracts, expenses, employees, customers, invoices or licences. Reads what this user is currently permitted to do from Weldall's live catalog, then follows the skill document Weldall returns. Not for the local repository, for general knowledge, or for anything on the user's own machine.",
};

export const assembleSkill = (procedure) =>
  `---\nname: ${FRONTMATTER.name}\ndescription: ${FRONTMATTER.description}\n---\n\n${procedure}`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const target = join(root, "skills", "weldall", "SKILL.md");
  await writeFile(target, assembleSkill(await readFile(join(root, "procedure.md"), "utf8")));
  console.log(`Wrote ${target}`);
}
