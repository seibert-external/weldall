import { describe, expect, it } from "vitest";
import { approvalLabel } from "../src/app/(admin)/browser-connection-presentation.js";
import { auditEventLabel, auditMetadataEntries } from "../src/app/(admin)/audit/presentation.js";

// These presentation contracts are intentionally tested without a browser DOM;
// the production Next build and system Playwright path exercise the components.
describe("browser connection administration presentation", () => {
  it("renders explicit approval and browser audit labels", () => {
    expect(approvalLabel("cli-code")).toBe("CLI code");
    expect(approvalLabel("browser-oauth")).toBe("Browser OAuth");
    expect(auditEventLabel("browser_connection.requested")).toBe("Browser connection requested");
    expect(auditEventLabel("browser_connection.revoked")).toBe("Browser connection revoked");
  });

  it("renders safe structured metadata without inventing credential fields", () => {
    const entries = auditMetadataEntries({
      connectionId: "connection-1",
      browserClientId: "weldall-browser:expenses",
      origin: "https://expenses.example",
      resourceIdentifier: "https://expenses.example/api",
      approvedVia: "cli-code",
      revokedAt: null,
    });
    expect(entries).toEqual([
      ["Connection Id", "connection-1"],
      ["Browser Client Id", "weldall-browser:expenses"],
      ["Origin", "https://expenses.example"],
      ["Resource Identifier", "https://expenses.example/api"],
      ["Approved Via", "cli-code"],
    ]);
    expect(JSON.stringify(entries)).not.toMatch(
      /device.?code|refresh.?token|authorization|proof/iu,
    );
  });
});
