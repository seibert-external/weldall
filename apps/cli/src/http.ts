import { CliError } from "./errors.js";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function responseValue(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

export async function successfulResponse(response: Response, label: string): Promise<unknown> {
  const value = await responseValue(response);
  if (!response.ok) {
    const detail =
      isRecord(value) && typeof value.error_description === "string"
        ? value.error_description
        : isRecord(value) && typeof value.error === "string"
          ? value.error
          : typeof value === "string" && value.length <= 300
            ? value
            : undefined;
    throw new CliError(
      `${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return value;
}
