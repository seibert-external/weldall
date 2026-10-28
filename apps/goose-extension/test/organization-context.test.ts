import { describe, expect, it } from "vitest";
import { buildInstructions, instructions } from "../src/server.js";

describe("organization instructions in the host prompt", () => {
  it("includes the current organization's text verbatim without hardcoded company routing", () => {
    const first =
      "Example A owns Product A.\nUse weldall skills list --agentic before every task; read all entries.";
    const second = "Example B owns Product B.\nUse skills find for discovery.";
    expect(buildInstructions(first)).toBe(
      instructions + "\n\n## Organization instructions\n\n" + first,
    );
    expect(buildInstructions(second)).toContain(second);
    expect(buildInstructions(second)).not.toContain(first);
  });
  it("uses discovery-first with activation only for capable CLIs", () => {
    const organization = "Ask before sending mail.";
    const native = buildInstructions(organization, 1);
    expect(native).toContain("use discover_integrations as the primary entry point");
    expect(native).toContain("activating by default");
    expect(native).toContain("use them directly without repeating discovery");
    expect(native).toContain("only for an explicitly requested catalog-only overview");
    expect(native).toContain("obtain the required user authorization");
    expect(native).toContain("does not imply that every operation");
    expect(native).not.toContain("use search_skills first");
    expect(native).not.toContain("search_skills-first default");
    expect(native).toContain(organization);
    const legacy = buildInstructions(organization);
    expect(legacy).toContain("use search_skills first");
    expect(legacy).toContain("including a read-only POST query transport");
    expect(legacy).not.toContain("discover_integrations");
  });
  it("makes an intentionally empty configuration explicit", () => {
    expect(buildInstructions("")).toContain("No organization instructions configured.");
  });
});
