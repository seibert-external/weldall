export function approvalLabel(value: string): string {
  return value === "cli-code" ? "CLI code" : value === "browser-oauth" ? "Browser OAuth" : value;
}
