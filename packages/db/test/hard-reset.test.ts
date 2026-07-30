import { describe, expect, it } from "vitest";
import {
  assertDeploymentModeMatches,
  confirmProductionReset,
  parseResetMode,
  seedScriptsForMode,
} from "../scripts/hard-reset-options.js";

describe("hard database reset options", () => {
  it("accepts an explicit development reset", () => {
    expect(parseResetMode(["--", "development"])).toBe("development");
  });

  it("requires explicit confirmation for a production reset", () => {
    expect(() => parseResetMode(["production"])).toThrow(
      "Production reset requires the explicit --confirm-production-reset confirmation flag.",
    );
  });

  it("accepts an explicitly confirmed production reset", () => {
    expect(parseResetMode(["--", "production", confirmProductionReset])).toBe("production");
  });

  it("rejects missing modes and unknown options", () => {
    expect(() => parseResetMode([])).toThrow("Reset mode is required.");
    expect(() => parseResetMode(["development", "--unexpected"])).toThrow(
      "Unknown reset option: --unexpected",
    );
  });

  it("rejects a reset mode that conflicts with the configured deployment", () => {
    expect(() => assertDeploymentModeMatches("development", "production")).toThrow(
      "Reset mode development does not match WELDALL_DEPLOYMENT_MODE=production.",
    );
    expect(() => assertDeploymentModeMatches("production", "development")).toThrow(
      "Reset mode production does not match WELDALL_DEPLOYMENT_MODE=development.",
    );
    expect(() => assertDeploymentModeMatches("development", "development")).not.toThrow();
    expect(() => assertDeploymentModeMatches("production", undefined)).not.toThrow();
  });

  it("selects development-only seed data only in development mode", () => {
    expect(seedScriptsForMode("development")).toEqual(["prisma/seed.ts", "prisma/seed.dev.ts"]);
    expect(seedScriptsForMode("production")).toEqual(["prisma/seed.ts"]);
  });
});
