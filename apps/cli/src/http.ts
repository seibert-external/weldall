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
  return ((input: string | URL | Request, init?: RequestInit) =>
    httpsRequest(input, init, deadline - Date.now())) as typeof fetch;
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

const throwResponseError = async (response: Response, label: string): Promise<never> => {
  const value = await responseValue(response);
  const detail =
    isRecord(value) && typeof value.error_description === "string"
      ? value.error_description
      : isRecord(value) && typeof value.error === "string"
        ? value.error
        : typeof value === "string" && value.length <= 300
          ? value
          : undefined;
  throw new CliError(`${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
};

export async function successfulResponse(response: Response, label: string): Promise<unknown> {
  if (!response.ok) return throwResponseError(response, label);
  return responseValue(response);
}

export async function successfulResponseStream(
  response: Response,
  label: string,
): Promise<Response> {
  if (!response.ok) return throwResponseError(response, label);
  return response;
}
