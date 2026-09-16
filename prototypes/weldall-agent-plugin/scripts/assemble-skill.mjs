import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");

// The registry of host wrappers. Each one packages the same skill for a different agent, so a
// new host is an entry here, its manifest, and nothing else. `manifest` is relative to the
// prototype root and carries the version the wrapper ships.
export const HOSTS = [
  { id: "claude-code", manifest: join("hosts", "claude-code", ".claude-plugin", "plugin.json") },
];

export const skillPath = (host) => join(root, "hosts", host.id, "skills", "weldall", "SKILL.md");

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
  const skill = assembleSkill(await readFile(join(root, "procedure.md"), "utf8"));
  for (const host of HOSTS) {
    const target = skillPath(host);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, skill);
    console.log(`Wrote ${target}`);
  }
}
