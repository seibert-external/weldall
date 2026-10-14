import { readFile } from "node:fs/promises";
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const params = new URLSearchParams({ cmd: "npx" });
params.append("arg", "-y");
params.append("arg", `${pkg.name}@${pkg.version}`);
for (const [key, value] of Object.entries({
  timeout: "300",
  id: "weldall",
  name: "Weldall",
  description: "Requires the local Weldall binary in PATH.",
}))
  params.set(key, value);
console.log(`goose://extension?${params}`);
