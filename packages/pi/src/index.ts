import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ListedSkill = { slug?: unknown; id?: unknown; title?: unknown };
type Skill = { slug: string; title: string; document: string };
const require = createRequire(import.meta.url);

export function commandName(slug: string, used: Set<string>): string {
  const base = `weldall-${slug.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "skill"}`;
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}-${n++}`;
  used.add(name);
  return name;
}

export async function runCli(
  args: string[],
  timeoutMs = 20_000,
  resolveEntry = () => require.resolve("@weldall/cli/dist/index.js"),
): Promise<unknown> {
  let entry: string;
  try {
    entry = resolveEntry();
  } catch {
    throw new Error("@weldall/cli is missing or incompatible; install it with npm install @weldall/cli");
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      callback();
    };
    const timeoutTimer = setTimeout(() => {
      finish(() => {
        child.kill("SIGTERM");
        forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        forceTimer.unref?.();
        reject(new Error("WeldAll CLI timed out; check network connectivity and try again."));
      });
    }, timeoutMs);
    timeoutTimer.unref?.();
    child.stdout.on("data", (data) => { out += data; });
    child.on("error", (error) => finish(() => reject(new Error(`WeldAll CLI failed: ${error.message}`))));
    child.on("close", (code) => finish(() => {
      if (code !== 0) {
        reject(new Error("WeldAll CLI could not fetch skills; check login, network, and access."));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("WeldAll CLI returned invalid skill data."));
      }
    }));
  });
}

export async function fetchSkills(run = runCli): Promise<Skill[]> {
  const listed = await run(["skills", "--json"]);
  if (typeof listed !== "object" || listed === null || !("items" in listed) || !("warnings" in listed)) {
    throw new Error("WeldAll CLI returned an unexpected skill list; update @weldall/cli and try again.");
  }
  const { items, warnings } = listed as { items: unknown; warnings: unknown };
  if (!Array.isArray(items) || !Array.isArray(warnings)) {
    throw new Error("WeldAll CLI returned an unexpected skill list; update @weldall/cli and try again.");
  }
  if (warnings.length > 0) {
    throw new Error("WeldAll skill catalog is unavailable or stale; check network and access, then refresh.");
  }
  const result: Skill[] = [];
  for (const item of items as ListedSkill[]) {
    if (typeof item !== "object" || item === null || typeof item.slug !== "string" || !item.slug.trim()) {
      throw new Error("WeldAll CLI returned an invalid skill entry; update @weldall/cli and try again.");
    }
    const slug = item.slug;
    const value = await run(["skills", "show", slug, "--json"]) as { document?: unknown; title?: unknown };
    if (typeof value.document !== "string") {
      throw new Error(`WeldAll CLI returned unexpected skill data for ${slug}; update @weldall/cli and try again.`);
    }
    result.push({ slug, title: typeof value.title === "string" ? value.title : slug, document: value.document });
  }
  return result;
}

function instructions(skills: Skill[]): string {
  return skills.length
    ? `WeldAll skills (administrator-managed):\n\n${skills.map((skill) => `## ${skill.slug}\n${skill.document}`).join("\n\n")}`
    : "WeldAll skills: none visible to this account.";
}

export function createExtension(loadSkills: () => Promise<Skill[]> = fetchSkills) {
  return function weldall(pi: ExtensionAPI) {
    let skills: Skill[] = [];
    const install = async (ctx: ExtensionContext, notify: boolean) => {
      try {
        skills = await loadSkills();
        const used = new Set(pi.getCommands().map((command) => command.name));
        used.add("weldall-refresh");
        for (const skill of skills) {
          const name = commandName(skill.slug, used);
          pi.registerCommand(name, {
            description: `WeldAll skill: ${skill.title}`,
            handler: async () => { pi.sendUserMessage(`Activate this WeldAll administrator-managed skill:\n\n${skill.document}`); },
          });
        }
        if (notify) ctx.ui.notify(`WeldAll: ${skills.length} skill${skills.length === 1 ? "" : "s"} loaded.`, "info");
      } catch (error) {
        skills = [];
        ctx.ui.notify(error instanceof Error ? error.message : "WeldAll skills could not be loaded.", "error");
      }
    };

    pi.registerCommand("weldall-refresh", {
      description: "Refresh WeldAll administrator-managed skills",
      handler: async (_args, ctx) => { await ctx.reload(); },
    });
    pi.on("session_start", (event, ctx) => install(ctx, event.reason === "reload"));
    pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${instructions(skills)}` }));
  };
}

export default createExtension();
