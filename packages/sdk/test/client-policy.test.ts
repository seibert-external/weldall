import { describe, expect, it } from "vitest";
import { clientPolicySchema, defaultClientPolicySchema } from "../src/client-policy.js";

const model = { name: "gpt", context_limit: 128_000, supports_vision: true };
const extensions = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`e${index}`, true]));
const slugs = (count: number) => Array.from({ length: count }, (_, index) => `skill.${index}`);
const modelKey = {
  url: "https://vllm.example.com/launcher/v1/weldall/key",
  hosts: ["vllm.example.com"],
};
const withModelKey = (value: Record<string, unknown>) => ({
  version: 1,
  modelKey: { ...modelKey, ...value },
});

// Each case sits on a boundary of one field: [valid as a group policy, valid as the default].
const cases: Record<string, [unknown, boolean, boolean]> = {
  minimal: [{ version: 1 }, true, true],
  full: [
    {
      version: 1,
      approvalMode: "smart_approve",
      extensions: { developer: true, memory: false },
      shell: false,
      models: { provider: "openai", allowed: [model] },
      instructions: "Be careful.",
    },
    true,
    false,
  ],
  "chat approval mode": [{ version: 1, approvalMode: "chat" }, true, true],
  "unknown approval mode": [{ version: 1, approvalMode: "yolo" }, false, false],
  "version 2": [{ version: 2 }, false, false],
  "missing version": [{ approvalMode: "auto" }, false, false],
  "unknown field": [{ version: 1, theme: "dark" }, false, false],
  "100 extensions": [{ version: 1, extensions: extensions(100) }, true, true],
  "101 extensions": [{ version: 1, extensions: extensions(101) }, false, false],
  "empty extension key": [{ version: 1, extensions: { "": true } }, false, false],
  "long extension key": [{ version: 1, extensions: { ["x".repeat(101)]: true } }, false, false],
  "non-boolean extension": [{ version: 1, extensions: { developer: "yes" } }, false, false],
  "non-boolean shell": [{ version: 1, shell: "no" }, false, false],
  "no allowed models": [{ version: 1, models: { provider: "openai", allowed: [] } }, false, false],
  "201 allowed models": [
    {
      version: 1,
      models: { provider: "openai", allowed: Array.from({ length: 201 }, () => model) },
    },
    false,
    false,
  ],
  "empty provider": [{ version: 1, models: { provider: "", allowed: [model] } }, false, false],
  "unknown models field": [
    { version: 1, models: { provider: "openai", allowed: [model], default: "gpt" } },
    false,
    false,
  ],
  "unknown model field": [
    { version: 1, models: { provider: "openai", allowed: [{ ...model, price: 1 }] } },
    false,
    false,
  ],
  "fractional context limit": [
    { version: 1, models: { provider: "openai", allowed: [{ ...model, context_limit: 1.5 }] } },
    false,
    false,
  ],
  "zero context limit": [
    { version: 1, models: { provider: "openai", allowed: [{ ...model, context_limit: 0 }] } },
    false,
    false,
  ],
  "100k instructions": [{ version: 1, instructions: "x".repeat(100_000) }, true, false],
  "instructions over 100k": [{ version: 1, instructions: "x".repeat(100_001) }, false, false],
  "no home skills": [{ version: 1, homeSkills: [] }, true, true],
  "50 home skills": [{ version: 1, homeSkills: slugs(50) }, true, true],
  "51 home skills": [{ version: 1, homeSkills: slugs(51) }, false, false],
  "duplicate home skills": [{ version: 1, homeSkills: ["a.b", "c.d", "a.b"] }, false, false],
  "empty home skill": [{ version: 1, homeSkills: [""] }, false, false],
  "200-character home skill": [{ version: 1, homeSkills: ["x".repeat(200)] }, true, true],
  "201-character home skill": [{ version: 1, homeSkills: ["x".repeat(201)] }, false, false],
  "model key": [{ version: 1, modelKey }, false, true],
  "model key URL host in another case": [
    withModelKey({ url: "https://VLLM.Example.com/key" }),
    false,
    true,
  ],
  "model key with 20 hosts": [
    withModelKey({ hosts: ["vllm.example.com", ...slugs(19).map((slug) => `${slug}.example`)] }),
    false,
    true,
  ],
  "model key with 21 hosts": [
    withModelKey({ hosts: ["vllm.example.com", ...slugs(20).map((slug) => `${slug}.example`)] }),
    false,
    false,
  ],
  "model key over http": [withModelKey({ url: "http://vllm.example.com/key" }), false, false],
  "relative model key URL": [withModelKey({ url: "/launcher/v1/weldall/key" }), false, false],
  "model key URL host not listed": [
    withModelKey({ url: "https://other.example.com/key" }),
    false,
    false,
  ],
  "upper-case model key host": [
    withModelKey({ url: "https://vllm.example.com/key", hosts: ["VLLM.example.com"] }),
    false,
    false,
  ],
  "empty model key host": [withModelKey({ hosts: ["vllm.example.com", ""] }), false, false],
  "no model key hosts": [withModelKey({ hosts: [] }), false, false],
  "model key host with scheme": [
    withModelKey({ hosts: ["vllm.example.com", "https://vllm.example.com"] }),
    false,
    false,
  ],
  "model key host with port": [
    withModelKey({ hosts: ["vllm.example.com", "vllm.example.com:443"] }),
    false,
    false,
  ],
  "model key host with path": [
    withModelKey({ hosts: ["vllm.example.com", "vllm.example.com/key"] }),
    false,
    false,
  ],
  "unknown model key field": [withModelKey({ header: "x-key" }), false, false],
};

describe("client policy schemas", () => {
  for (const [name, [value, group, fallback]] of Object.entries(cases))
    it(name, () => {
      expect(clientPolicySchema.safeParse(value).success).toBe(group);
      expect(defaultClientPolicySchema.safeParse(value).success).toBe(fallback);
    });
});
