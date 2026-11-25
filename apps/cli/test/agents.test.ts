import { describe, expect, it } from "vitest";
import { parseAgentList } from "../src/services/agents.js";

const agent = {
  id: "registry.agt_1",
  sourceId: "agt_1",
  name: "Intranet helper",
  description: "Answers questions about the intranet",
  own: false,
  ownerName: "Olivia Owner",
  scopes: ["intranet:user"],
  config: { format: "weldall-agent", version: 1, definition: { instructions: "Help." } },
  revision: 1,
  updatedAt: "2026-11-20T10:00:00.000Z",
  expiresAt: "2027-02-18T10:00:00.000Z",
  expired: false,
  source: { type: "resource", key: "registry", name: "Registry" },
};

describe("agent list", () => {
  it("accepts what GET /api/me/agents serves", () => {
    const list = { items: [agent, { ...agent, own: true, ownerName: null }], warnings: [] };
    expect(parseAgentList(list)).toEqual(list);
    expect(
      parseAgentList({ items: [], warnings: [{ source: "registry", code: "catalog_expired" }] })
        .warnings,
    ).toHaveLength(1);
  });

  it.each([
    ["no object", []],
    ["no items", { warnings: [] }],
    ["an agent without a name", { items: [{ ...agent, name: undefined }], warnings: [] }],
    ["an agent without a config", { items: [{ ...agent, config: null }], warnings: [] }],
    ["a malformed warning", { items: [], warnings: ["catalog_expired"] }],
  ])("refuses %s", (_name, value) => {
    expect(() => parseAgentList(value)).toThrow("invalid agent list");
  });
});
