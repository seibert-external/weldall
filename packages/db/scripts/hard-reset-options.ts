export type ResetMode = "development" | "production";

export const confirmProductionReset = "--confirm-production-reset";

export function assertDeploymentModeMatches(mode: ResetMode, configuredMode?: string): void {
  if (configuredMode && configuredMode !== mode) {
    throw new Error(`Reset mode ${mode} does not match WELDALL_DEPLOYMENT_MODE=${configuredMode}.`);
  }
}

export function seedScriptsForMode(mode: ResetMode): string[] {
  return mode === "development" ? ["prisma/seed.ts", "prisma/seed.dev.ts"] : ["prisma/seed.ts"];
}

export function parseResetMode(arguments_: string[]): ResetMode {
  const [mode, ...flags] = arguments_.filter((argument) => argument !== "--");
  if (mode !== "development" && mode !== "production") {
    throw new Error(
      "Reset mode is required. Use `reset:hard -- development` or `reset:hard -- production --confirm-production-reset`.",
    );
  }
  const unknownFlags = flags.filter((flag) => flag !== confirmProductionReset);
  if (unknownFlags.length) {
    throw new Error(`Unknown reset option: ${unknownFlags.join(", ")}`);
  }
  if (mode === "production" && !flags.includes(confirmProductionReset)) {
    throw new Error(
      "Production reset requires the explicit --confirm-production-reset confirmation flag.",
    );
  }
  return mode;
}
