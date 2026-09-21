// opencode has no manifest field for skills. A plugin package's skill directory is only scanned
// once something puts it on `config.skills.paths`, so this module exists to do that and registers
// no hooks of its own.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skills = join(dirname(fileURLToPath(import.meta.url)), "skills");

export default async () => ({
  config: (config) => {
    config.skills ??= {};
    config.skills.paths ??= [];
    if (!config.skills.paths.includes(skills)) config.skills.paths.push(skills);
  },
});
