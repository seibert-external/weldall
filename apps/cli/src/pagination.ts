import type { WeldallConfig } from "./config.js";
import { CliError, errorMessage } from "./errors.js";
import { phaseTiming, timingNow } from "./timing.js";
import { prepareResourceClient, type PreparedResourceClient } from "./services/resources.js";

export const MAX_PAGE_SIZE = 1_000;
export const MAX_PAGE_COUNT = 1_000;
export const MAX_PAGE_CONCURRENCY = 10;
export const MAX_PAGINATED_RESPONSE_BYTES = 50 * 1024 * 1024;

export interface OffsetPaginationOptions {
  url: string;
  scopes: string[];
  headers?: Record<string, string>;
  pageSize: number;
  totalPagesPointer: string;
  maxPages: number;
  concurrency: number;
  limitParameter?: string;
  offsetParameter?: string;
  maxResponseBytes?: number;
}

const queryParameter = (value: string, label: string) => {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value))
    throw new CliError(`${label} must be a safe query-parameter name`);
  return value;
};

export const jsonPointerValue = (value: unknown, pointer: string): unknown => {
  if (pointer === "") return value;
  if (!pointer.startsWith("/"))
    throw new CliError("--total-pages-pointer must be an RFC 6901 JSON Pointer");
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(raw))
      throw new CliError("--total-pages-pointer contains an invalid RFC 6901 escape");
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) >= current.length)
        throw new CliError(`--total-pages-pointer did not resolve at ${JSON.stringify(token)}`);
      current = current[Number(token)];
    } else if (typeof current === "object" && current !== null && token in current) {
      current = (current as Record<string, unknown>)[token];
    } else {
      throw new CliError(`--total-pages-pointer did not resolve at ${JSON.stringify(token)}`);
    }
  }
  return current;
};

const pageUrl = (
  source: string,
  page: number,
  pageSize: number,
  limitParameter: string,
  offsetParameter: string,
) => {
  const url = new URL(source);
  url.searchParams.set(limitParameter, String(pageSize));
  url.searchParams.set(offsetParameter, String(page * pageSize));
  return url.toString();
};

const boundedResponseBytes = async (
  response: Response,
  addBytes: (count: number) => void,
): Promise<Uint8Array> => {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      addBytes(value.byteLength);
      chunks.push(value);
      length += value.byteLength;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const pageObject = async (response: Response, addBytes: (count: number) => void) => {
  const bytes = await boundedResponseBytes(response, addBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new CliError("The response was not valid JSON", { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CliError("The response was not a JSON object");
  return value as Record<string, unknown>;
};

const requestPage = async (
  client: PreparedResourceClient,
  options: OffsetPaginationOptions,
  page: number,
  limitParameter: string,
  offsetParameter: string,
  signal: AbortSignal,
  addBytes: (count: number) => void,
) => {
  const offset = page * options.pageSize;
  try {
    const response = await client.request({
      url: pageUrl(options.url, page, options.pageSize, limitParameter, offsetParameter),
      method: "GET",
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      signal,
    });
    return await pageObject(response, addBytes);
  } catch (error) {
    throw new CliError(`Page ${page + 1} at offset ${offset} failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }
};

export async function paginateOffset(
  config: WeldallConfig,
  options: OffsetPaginationOptions,
): Promise<Record<string, unknown>[]> {
  if (
    !Number.isInteger(options.pageSize) ||
    options.pageSize < 1 ||
    options.pageSize > MAX_PAGE_SIZE
  )
    throw new CliError(`Page size must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  if (
    !Number.isInteger(options.maxPages) ||
    options.maxPages < 1 ||
    options.maxPages > MAX_PAGE_COUNT
  )
    throw new CliError(`Maximum pages must be an integer between 1 and ${MAX_PAGE_COUNT}`);
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > MAX_PAGE_CONCURRENCY
  )
    throw new CliError(`Concurrency must be an integer between 1 and ${MAX_PAGE_CONCURRENCY}`);
  const maxBytes = options.maxResponseBytes ?? MAX_PAGINATED_RESPONSE_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PAGINATED_RESPONSE_BYTES)
    throw new CliError(
      `Response-byte limit must be an integer between 1 and ${MAX_PAGINATED_RESPONSE_BYTES}`,
    );

  const limitParameter = queryParameter(options.limitParameter ?? "limit", "Limit parameter");
  const offsetParameter = queryParameter(options.offsetParameter ?? "offset", "Offset parameter");
  if (limitParameter === offsetParameter)
    throw new CliError("Limit and offset parameter names must differ");
  const firstUrl = pageUrl(options.url, 0, options.pageSize, limitParameter, offsetParameter);
  const client = await prepareResourceClient(config, firstUrl, options.scopes);
  const pagesStartedAt = timingNow();
  const controller = new AbortController();
  let responseBytes = 0;
  const addBytes = (count: number) => {
    responseBytes += count;
    if (responseBytes > maxBytes)
      throw new CliError(
        `Paginated response exceeded the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit`,
      );
  };

  const results: Record<string, unknown>[] = [];
  try {
    const first = await requestPage(
      client,
      options,
      0,
      limitParameter,
      offsetParameter,
      controller.signal,
      addBytes,
    );
    results[0] = first;
    const totalPages = jsonPointerValue(first, options.totalPagesPointer);
    if (!Number.isInteger(totalPages) || (totalPages as number) <= 0)
      throw new CliError("The total page count must be an integer greater than zero");
    if ((totalPages as number) > options.maxPages)
      throw new CliError(
        `The API reported ${totalPages as number} pages, exceeding --max-pages ${options.maxPages}`,
      );

    let nextPage = 1;
    const workers = Array.from(
      { length: Math.min(options.concurrency, Math.max(0, (totalPages as number) - 1)) },
      async () => {
        while (true) {
          const page = nextPage++;
          if (page >= (totalPages as number)) return;
          results[page] = await requestPage(
            client,
            options,
            page,
            limitParameter,
            offsetParameter,
            controller.signal,
            addBytes,
          );
        }
      },
    );
    try {
      await Promise.all(workers);
    } catch (error) {
      controller.abort(error);
      await Promise.allSettled(workers);
      throw error;
    }
    phaseTiming("api-pages", pagesStartedAt);
    return results;
  } catch (error) {
    controller.abort(error);
    phaseTiming("api-pages", pagesStartedAt);
    throw error;
  }
}
