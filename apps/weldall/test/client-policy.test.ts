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
      { version: 1, approvalMode: "smart_approve", shell: false },
      [{ version: 1, approvalMode: "chat" }],
    );
    expect(merged).toEqual({ version: 1, approvalMode: "chat", shell: false });
  });

  it("lets the most permissive group win", () => {
    const merged = mergeClientPolicies({ version: 1 }, [
      { version: 1, approvalMode: "approve", shell: false, extensions: { developer: false } },
      {
        version: 1,
        approvalMode: "auto",
        shell: true,
        extensions: { developer: true, computercontroller: false },
      },
    ]);
    expect(merged).toEqual({
      version: 1,
      approvalMode: "auto",
      shell: true,
      extensions: { developer: true, computercontroller: false },
    });
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
});
