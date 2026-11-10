import { describe, expect, it } from "vitest";
import * as cli from "../src/iac/client-policy.js";
import * as server from "../../weldall/src/server/policy/client-policy.js";

const model = { name: "gpt", context_limit: 128_000, supports_vision: true };
const longKey = "x".repeat(101);
const manyExtensions = Object.fromEntries(
  Array.from({ length: 101 }, (_, index) => [`e${index}`, true]),
);

// Each case sits on a boundary of one field, so a drift in either copy flips at least one result.
const cases: Record<string, unknown> = {
  minimal: { version: 1 },
  full: {
    version: 1,
    approvalMode: "smart_approve",
    extensions: { developer: true, memory: false },
    shell: false,
    models: { provider: "openai", allowed: [model] },
    instructions: "Be careful.",
  },
  "chat approval mode": { version: 1, approvalMode: "chat" },
  "unknown approval mode": { version: 1, approvalMode: "yolo" },
  "version 2": { version: 2 },
  "missing version": { approvalMode: "auto" },
  "unknown field": { version: 1, theme: "dark" },
  "100 extensions": {
    version: 1,
    extensions: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`e${i}`, true])),
  },
  "101 extensions": { version: 1, extensions: manyExtensions },
  "empty extension key": { version: 1, extensions: { "": true } },
  "long extension key": { version: 1, extensions: { [longKey]: true } },
  "non-boolean extension": { version: 1, extensions: { developer: "yes" } },
  "non-boolean shell": { version: 1, shell: "no" },
  "no allowed models": { version: 1, models: { provider: "openai", allowed: [] } },
  "201 allowed models": {
    version: 1,
    models: { provider: "openai", allowed: Array.from({ length: 201 }, () => model) },
  },
  "empty provider": { version: 1, models: { provider: "", allowed: [model] } },
  "unknown models field": {
    version: 1,
    models: { provider: "openai", allowed: [model], default: "gpt" },
  },
  "unknown model field": {
    version: 1,
    models: { provider: "openai", allowed: [{ ...model, price: 1 }] },
  },
  "fractional context limit": {
    version: 1,
    models: { provider: "openai", allowed: [{ ...model, context_limit: 1.5 }] },
  },
  "zero context limit": {
    version: 1,
    models: { provider: "openai", allowed: [{ ...model, context_limit: 0 }] },
  },
  "100k instructions": { version: 1, instructions: "x".repeat(100_000) },
  "instructions over 100k": { version: 1, instructions: "x".repeat(100_001) },
};

describe("the CLI's client policy schema", () => {
  for (const [name, value] of Object.entries(cases)) {
    it(`agrees with the server on: ${name}`, () => {
      expect(cli.clientPolicySchema.safeParse(value).success).toBe(
        server.clientPolicySchema.safeParse(value).success,
      );
      expect(cli.defaultClientPolicySchema.safeParse(value).success).toBe(
        server.defaultClientPolicySchema.safeParse(value).success,
      );
    });
  }
});
