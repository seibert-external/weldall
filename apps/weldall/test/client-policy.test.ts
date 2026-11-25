import { describe, expect, it } from "vitest";
import {
  clientPolicySchema,
  defaultClientPolicySchema,
  mergeClientPolicies,
  policyEtag,
} from "../src/server/policy/client-policy";

describe("client policy", () => {
  it("returns an empty version-1 policy without default or groups", () => {
    expect(mergeClientPolicies(null, [])).toEqual({ version: 1 });
  });

  it("keeps a default field no group sets and lets a group replace it", () => {
    const merged = mergeClientPolicies(
      { version: 1, approvalMode: "smart_approve", shell: false, sandbox: true },
      [{ version: 1, approvalMode: "chat" }],
    );
    expect(merged).toEqual({ version: 1, approvalMode: "chat", shell: false, sandbox: true });
  });

  it("lets the most permissive group win", () => {
    const merged = mergeClientPolicies({ version: 1 }, [
      {
        version: 1,
        approvalMode: "approve",
        shell: false,
        sandbox: true,
        extensions: { developer: false },
      },
      {
        version: 1,
        approvalMode: "auto",
        shell: true,
        sandbox: false,
        extensions: { developer: true, computercontroller: false },
      },
    ]);
    expect(merged).toEqual({
      version: 1,
      approvalMode: "auto",
      shell: true,
      sandbox: false,
      extensions: { developer: true, computercontroller: false },
    });
  });

  it("merges extensions per key, keeping default keys no group sets", () => {
    const merged = mergeClientPolicies(
      { version: 1, extensions: { computercontroller: false, developer: false } },
      [{ version: 1, extensions: { developer: true } }],
    );
    expect(merged.extensions).toEqual({ computercontroller: false, developer: true });
  });

  it("unions models of the same provider and drops another provider's", () => {
    const model = (name: string) => ({ name, context_limit: 1, supports_vision: false });
    const merged = mergeClientPolicies(null, [
      { version: 1, models: { provider: "p", allowed: [model("a")] } },
      { version: 1, models: { provider: "p", allowed: [model("b"), model("a")] } },
      { version: 1, models: { provider: "q", allowed: [model("c")] } },
    ]);
    expect(merged.models).toEqual({ provider: "p", allowed: [model("a"), model("b")] });
  });

  it("concatenates group instructions in order", () => {
    const merged = mergeClientPolicies(null, [
      { version: 1, instructions: "one" },
      { version: 1, instructions: "two" },
    ]);
    expect(merged.instructions).toBe("one\n\ntwo");
  });

  it("puts every group's home skills in group order before the default's, first position kept", () => {
    const merged = mergeClientPolicies({ version: 1, homeSkills: ["d.one", "g.two"] }, [
      { version: 1, homeSkills: ["g.one", "g.two"] },
      { version: 1 },
      { version: 1, homeSkills: ["g.three", "g.one"] },
    ]);
    expect(merged.homeSkills).toEqual(["g.one", "g.two", "g.three", "d.one"]);
  });

  it("caps merged home skills at 50", () => {
    const slugs = (prefix: string) =>
      Array.from({ length: 30 }, (_, index) => `${prefix}.${index}`);
    const merged = mergeClientPolicies({ version: 1, homeSkills: slugs("d") }, [
      { version: 1, homeSkills: slugs("g") },
    ]);
    expect(merged.homeSkills).toEqual([...slugs("g"), ...slugs("d").slice(0, 20)]);
  });

  it("keeps an empty home skills list a group sets", () => {
    expect(mergeClientPolicies(null, [{ version: 1, homeSkills: [] }]).homeSkills).toEqual([]);
  });

  it("merges neither home skills nor model key when no policy sets them", () => {
    const merged = mergeClientPolicies({ version: 1, shell: true }, [{ version: 1, shell: false }]);
    expect(merged).not.toHaveProperty("homeSkills");
    expect(merged).not.toHaveProperty("modelKey");
  });

  it("takes the model key from the default only", () => {
    const modelKey = { url: "https://vllm.example.com/key", hosts: ["vllm.example.com"] };
    expect(mergeClientPolicies({ version: 1, modelKey }, [{ version: 1 }]).modelKey).toEqual(
      modelKey,
    );
    expect(mergeClientPolicies(null, [{ version: 1 }])).not.toHaveProperty("modelKey");
  });

  it("rejects a model key in a group policy", () => {
    const modelKey = { url: "https://vllm.example.com/key", hosts: ["vllm.example.com"] };
    expect(clientPolicySchema.safeParse({ version: 1, modelKey }).success).toBe(false);
    expect(defaultClientPolicySchema.safeParse({ version: 1, modelKey }).success).toBe(true);
  });

  it("rejects unknown fields and modes", () => {
    expect(clientPolicySchema.safeParse({ version: 1, approvalMode: "yolo" }).success).toBe(false);
    expect(clientPolicySchema.safeParse({ version: 1, tools: {} }).success).toBe(false);
    expect(defaultClientPolicySchema.safeParse({ version: 1, instructions: "x" }).success).toBe(
      false,
    );
  });

  it("gives the same etag for the same policy in any key order", () => {
    expect(policyEtag({ version: 1, shell: true, approvalMode: "auto" })).toBe(
      policyEtag({ approvalMode: "auto", version: 1, shell: true }),
    );
  });

  it("changes the etag when the home skills order changes", () => {
    expect(policyEtag({ version: 1, homeSkills: ["a", "b"] })).not.toBe(
      policyEtag({ version: 1, homeSkills: ["b", "a"] }),
    );
  });
});
