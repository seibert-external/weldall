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
  it("makes an intentionally empty configuration explicit", () => {
    expect(buildInstructions("")).toContain("No organization instructions configured.");
  });
});
