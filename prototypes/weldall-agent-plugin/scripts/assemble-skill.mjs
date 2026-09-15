import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");

export const FRONTMATTER = {
  name: "weldall",
  // The first sentence does double duty. It is what a person browsing a list of skills reads
  // first, so it says what the skill does before the trigger says when it fires.
  description:
    "Routes a request about a company system through Weldall, the access layer in front of those systems, instead of answering from memory or inventing an API call. Use when the request concerns a business record or an action on one, such as contracts, expenses, employees, customers, invoices or licences. Reads what this user is currently permitted to do from Weldall's live catalog, then follows the skill document Weldall returns. Not for the local repository, for general knowledge, or for anything on the user's own machine.",
};

export const assembleSkill = (procedure) =>
  `---\nname: ${FRONTMATTER.name}\ndescription: ${FRONTMATTER.description}\n---\n\n${procedure}`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const target = join(root, "skills", "weldall", "SKILL.md");
  await writeFile(target, assembleSkill(await readFile(join(root, "procedure.md"), "utf8")));
  console.log(`Wrote ${target}`);
}
