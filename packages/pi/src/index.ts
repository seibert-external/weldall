import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ListedSkill = { slug?: unknown; id?: unknown; title?: unknown };
type Skill = { slug: string; title: string; document: string };
const require = createRequire(import.meta.url);

export function commandName(slug: string, used: Set<string>): string {
  const base = `weldall-${slug.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "skill"}`;
  let name = base; let n = 2;
  while (used.has(name)) name = `${base}-${n++}`;
  used.add(name); return name;
}

async function runCli(args: string[]): Promise<unknown> {
  let entry: string;
  try { entry = require.resolve("@weldall/cli/dist/index.js"); }
  catch { throw new Error("@weldall/cli is missing or incompatible; install it with npm install @weldall/cli"); }
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    let out = ""; child.stdout.on("data", (d) => { out += d; });
    child.on("error", (e) => reject(new Error(`WeldAll CLI failed: ${e.message}`)));
    child.on("close", (code) => { if (code !== 0) return reject(new Error("WeldAll CLI could not fetch skills; check login, network, and access.")); try { resolve(JSON.parse(out)); } catch { reject(new Error("WeldAll CLI returned invalid skill data.")); } });
  });
}

async function fetchSkills(): Promise<Skill[]> {
  const listed = await runCli(["skills", "--json"]) as { items?: ListedSkill[] };
  if (!Array.isArray(listed.items)) throw new Error("WeldAll CLI returned an unexpected skill list.");
  const result: Skill[] = [];
  for (const item of listed.items) {
    const slug = typeof item.slug === "string" ? item.slug : typeof item.id === "string" ? item.id : "";
    if (!slug) continue;
    const value = await runCli(["skills", "show", slug, "--json"]) as { document?: unknown; title?: unknown };
    if (typeof value.document !== "string") continue;
    result.push({ slug, title: typeof value.title === "string" ? value.title : slug, document: value.document });
  }
  return result;
}

export default function weldall(pi: ExtensionAPI) {
  let skills: Skill[] = [];
  const install = async (ctx: ExtensionContext, notify = true) => {
    try {
      skills = await fetchSkills();
      const used = new Set<string>();
      for (const skill of skills) {
        const name = commandName(skill.slug, used);
        pi.registerCommand(name, { description: `WeldAll skill: ${skill.title}`, handler: async () => { pi.sendUserMessage(`WeldAll skill instructions (${skill.slug}):\n\n${skill.document}`); } });
      }
      pi.sendMessage({ customType: "weldall-skills", content: skills.length ? `WeldAll skills (administrator-managed):\n\n${skills.map((s) => `## ${s.slug}\n${s.document}`).join("\n\n")}` : "WeldAll skills: none visible to this account.", display: false }, { deliverAs: "nextTurn" });
      if (notify) ctx.ui.notify(`WeldAll: ${skills.length} skill${skills.length === 1 ? "" : "s"} loaded.`, "info");
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "WeldAll skills could not be loaded.", "error"); }
  };
  pi.registerCommand("weldall-refresh", { description: "Refresh WeldAll administrator-managed skills", handler: (args, ctx) => install(ctx) });
  pi.on("session_start", (_event, ctx) => install(ctx, false));
}
