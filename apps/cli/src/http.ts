import { request } from "node:https";
import { CliError } from "./errors.js";

const timeoutError = () => new DOMException("The operation timed out", "TimeoutError");

const httpsRequest = (
  input: string | URL | Request,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> => {
  if (timeoutMs <= 0) return Promise.reject(timeoutError());
  const source = input instanceof Request ? input : undefined;
  const url = new URL(source?.url ?? String(input));
  const headers = new Headers(source?.headers);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  const signal = init?.signal ?? source?.signal;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      fn();
    };
    const fail = (error: Error) => finish(() => reject(error));
    const requestValue = request(
      url,
      {
        method: init?.method ?? source?.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", fail);
        response.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value])
              responseHeaders.append(name, String(item));
          }
          finish(() =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode ?? 500,
                ...(response.statusMessage === undefined
                  ? {}
                  : { statusText: response.statusMessage }),
                headers: responseHeaders,
              }),
            ),
          );
        });
      },
    );
    const abort = () =>
      requestValue.destroy(signal?.reason instanceof Error ? signal.reason : timeoutError());
    const timer = setTimeout(() => requestValue.destroy(timeoutError()), timeoutMs);
    requestValue.on("error", fail);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    requestValue.end();
  });
};

export const createHttpsDeadlineFetch = (timeoutMs: number): typeof fetch => {
  const deadline = Date.now() + timeoutMs;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutError();
    // The test-only global bridge must also cover bounded help-header discovery.
    // Normal production traffic keeps the direct HTTPS implementation below.
    if (process.env["WELDALL_E2E_HTTP_BRIDGE"] !== undefined) {
      if (process.env["NODE_ENV"] !== "test")
        throw new CliError("WELDALL_E2E_HTTP_BRIDGE is only allowed when NODE_ENV=test");
      const sourceSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const timeoutSignal = AbortSignal.timeout(remaining);
      return fetch(input, {
        ...init,
        signal: sourceSignal ? AbortSignal.any([sourceSignal, timeoutSignal]) : timeoutSignal,
      });
    }
    return httpsRequest(input, init, remaining);
  }) as typeof fetch;
};

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

const MAX_ERROR_DETAIL_CHARS = 400;

const errorBodyText = (value: Record<string, unknown>): string | undefined => {
  for (const key of ["error_description", "message", "detail", "title", "reason"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  if (typeof value.error === "string" && value.error.trim() !== "") return value.error;
  if (isRecord(value.error)) {
    const nested = errorBodyText(value.error);
    if (nested !== undefined) return nested;
  }
  const messages = errorListMessages(value.errors);
  if (messages.length > 0) return messages.join("; ");
  return undefined;
};

const errorListMessages = (errors: unknown): string[] => {
  if (!Array.isArray(errors)) return [];
  const messages: string[] = [];
  for (const error of errors) {
    if (typeof error === "string") {
      const text = error.trim();
      if (text !== "") messages.push(text);
      continue;
    }
    if (!isRecord(error)) continue;
    const message = errorBodyText(error);
    if (message === undefined) continue;
    const field =
      typeof error.field === "string" && error.field.trim() !== "" ? error.field : undefined;
    messages.push(field === undefined ? message : `${field}: ${message}`);
  }
  return messages;
};

// Surface a readable detail from a failed response body instead of swallowing
// it. Handles OAuth errors, JSON:API-style field errors, short text, and a
// small JSON fallback so the response text never disappears entirely.
const describeResponseError = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const text = value.trim();
    return text === "" ? undefined : text;
  }
  if (isRecord(value)) {
    const text = errorBodyText(value);
    if (text !== undefined) return text;
  } else if (Array.isArray(value)) {
    const messages = errorListMessages(value);
    if (messages.length > 0) return messages.join("; ");
  }
  const compact = value === null ? undefined : JSON.stringify(value);
  return compact === undefined ? undefined : compact.slice(0, MAX_ERROR_DETAIL_CHARS);
};

const throwResponseError = async (
  response: Response,
  label: string,
  configurationHint?: string,
): Promise<never> => {
  const value = await responseValue(response);
  const detail = describeResponseError(value);
  throw new CliError(
    `${label} failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}` : ""}`,
    {
      ...(configurationHint !== undefined && (response.status === 404 || response.status === 410)
        ? { hint: configurationHint }
        : {}),
    },
  );
};

export async function successfulResponse(
  response: Response,
  label: string,
  configurationHint?: string,
): Promise<unknown> {
  if (!response.ok) return throwResponseError(response, label, configurationHint);
  return responseValue(response);
}

export async function successfulResponseStream(
  response: Response,
  label: string,
): Promise<Response> {
  if (!response.ok) return throwResponseError(response, label);
  return response;
}
