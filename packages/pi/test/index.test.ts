import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

import { commandName, createExtension, fetchSkills, runCli } from "../src/index.js";

function harness(loadSkills: () => Promise<Array<{ slug: string; title: string; document: string }>>) {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const messages: unknown[] = [];
  const pi = {
    getCommands: () => [{ name: "help" }],
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => handlers.set(name, handler),
    sendUserMessage: (message: unknown) => messages.push(message),
  };
  createExtension(loadSkills)(pi as any);
  return { commands, handlers, messages };
}

describe("WeldAll Pi extension", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes unsafe ids and reserves collisions", () => {
    const used = new Set(["weldall-refresh"]);
    expect(commandName("Finance/Review", used)).toBe("weldall-finance-review");
    expect(commandName("finance review", used)).toBe("weldall-finance-review-2");
    expect(commandName("refresh", used)).toBe("weldall-refresh-2");
    expect(commandName("!!!", used)).toBe("weldall-skill");
  });

  it("loads startup context, registers commands, and activates complete instructions", async () => {
    const app = harness(async () => [{ slug: "review", title: "Review", document: "Complete instructions" }]);
    await app.handlers.get("session_start")!({ reason: "startup" }, { ui: { notify: vi.fn() } });
    expect(app.commands.has("weldall-review")).toBe(true);
    expect((await app.handlers.get("before_agent_start")!({ systemPrompt: "base" }, {})).systemPrompt).toContain("Complete instructions");
    await app.commands.get("weldall-review")!.handler("", {});
    expect(app.messages).toEqual([expect.stringContaining("Complete instructions")]);
  });

  it("represents an empty skill set and refreshes through Pi reload", async () => {
    const reload = vi.fn();
    const app = harness(async () => []);
    await app.handlers.get("session_start")!({ reason: "startup" }, { ui: { notify: vi.fn() } });
    expect((await app.handlers.get("before_agent_start")!({ systemPrompt: "base" }, {})).systemPrompt).toContain("none visible");
    await app.commands.get("weldall-refresh")!.handler("", { reload });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("clears context and reports startup failures without throwing", async () => {
    const notify = vi.fn();
    const app = harness(async () => { throw new Error("logged out"); });
    await app.handlers.get("session_start")!({ reason: "startup" }, { ui: { notify } });
    expect(notify).toHaveBeenCalledWith("logged out", "error");
    expect((await app.handlers.get("before_agent_start")!({ systemPrompt: "base" }, {})).systemPrompt).toContain("none visible");
  });

  it("validates list and detail output", async () => {
    await expect(fetchSkills(async () => ({}))).rejects.toThrow("unexpected skill list");
    const run = vi.fn()
      .mockResolvedValueOnce({ items: [{ slug: "one" }, { slug: "two" }], warnings: [] })
      .mockResolvedValueOnce({ title: "One", document: "body" })
      .mockResolvedValueOnce({ document: 4 });
    await expect(fetchSkills(run)).rejects.toThrow("unexpected skill data for two");
  });

  it("rejects catalog warnings and malformed list entries", async () => {
    await expect(fetchSkills(async () => ({
      items: [{ slug: "stale" }],
      warnings: [{ source: "catalog", code: "catalog_temporarily_unavailable" }],
    }))).rejects.toThrow("catalog is unavailable or stale");
    await expect(fetchSkills(async () => ({ items: [{ id: "legacy" }], warnings: [] }))).rejects.toThrow("invalid skill entry");
    await expect(fetchSkills(async () => ({ items: [{ slug: " " }], warnings: [] }))).rejects.toThrow("invalid skill entry");
  });

  it("parses CLI output and converts failures to actionable errors", async () => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.kill = vi.fn();
    spawn.mockReturnValue(child);
    const result = runCli(["skills", "--json"]);
    child.stdout.end('{"items":[]}');
    child.emit("close", 0);
    await expect(result).resolves.toEqual({ items: [] });

    const failed = new EventEmitter() as any;
    failed.stdout = new PassThrough();
    failed.kill = vi.fn();
    spawn.mockReturnValue(failed);
    const failure = runCli(["skills", "--json"]);
    failed.emit("close", 1);
    await expect(failure).rejects.toThrow("check login, network, and access");

    const malformed = new EventEmitter() as any;
    malformed.stdout = new PassThrough();
    malformed.kill = vi.fn();
    spawn.mockReturnValue(malformed);
    const invalid = runCli(["skills", "--json"]);
    malformed.stdout.end("not json");
    malformed.emit("close", 0);
    await expect(invalid).rejects.toThrow("invalid skill data");

    await expect(runCli([], 20_000, () => { throw new Error("missing"); })).rejects.toThrow("npm install @weldall/cli");
  });

  it("rejects a hung CLI and terminates it", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.kill = vi.fn();
    spawn.mockReturnValue(child);
    const result = runCli(["skills", "--json"], 10);
    const assertion = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    vi.useRealTimers();
  });
});
