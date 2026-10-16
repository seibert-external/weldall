import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIPv4 } from "node:net";
import { McpBoundaryError } from "@weldall/sdk/mcp";

/** IPv4-only transport. Reject special-use ranges and pin the reviewed address into TLS. */
export function isPublicIpv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split(".").map(Number) as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 2, 168].includes(b)) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0)
  );
}

export async function resolvePublicIpv4(hostname: string): Promise<string> {
  const addresses = await lookup(hostname, { family: 4, all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIpv4(address)))
    throw new McpBoundaryError("upstream_unavailable");
  return addresses[0]!.address;
}

/** No proxy environment, redirects, credential challenge handlers or automatic retries.
 * The hostname remains the TLS servername; DNS cannot change between validation and connect.
 * Bodies stream into the SDK with a total byte limit (including SSE), not an unbounded buffer.
 */
export function createPinnedFetch(options: {
  validateUrl: (url: URL, method: string) => void;
  maximumBytes: number;
  signal: AbortSignal;
  resolve?: typeof resolvePublicIpv4;
  request?: typeof httpsRequest;
}): typeof fetch {
  return async (input, init = {}) => {
    try {
      if (input instanceof Request) throw new McpBoundaryError("upstream_protocol_error");
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      options.validateUrl(url, method);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port)
        throw new McpBoundaryError("upstream_unavailable");
      const signal = AbortSignal.any([options.signal, ...(init.signal ? [init.signal] : [])]);
      signal.throwIfAborted();
      const address = await (options.resolve ?? resolvePublicIpv4)(url.hostname);
      signal.throwIfAborted();
      const headers = new Headers(init.headers);
      if (
        ["host", "cookie", "proxy-authorization", "forwarded", "dpop"].some((key) =>
          headers.has(key),
        ) ||
        [...headers.keys()].some((key) => key.startsWith("x-forwarded-"))
      )
        throw new McpBoundaryError("upstream_protocol_error");
      headers.set("accept-encoding", "identity");
      const inputBody = init.body instanceof URLSearchParams ? init.body.toString() : init.body;
      if (
        inputBody !== undefined &&
        inputBody !== null &&
        typeof inputBody !== "string" &&
        !(inputBody instanceof Uint8Array)
      )
        throw new McpBoundaryError("upstream_protocol_error");
      const body = inputBody == null ? undefined : Buffer.from(inputBody);
      if (body && body.byteLength > 1024 * 1024) throw new McpBoundaryError("request_too_large");
      return await new Promise<Response>((resolve, reject) => {
        const req = (options.request ?? httpsRequest)(url, {
          method,
          headers: Object.fromEntries(headers),
          agent: false,
          family: 4,
          servername: url.hostname,
          maxHeaderSize: 32 * 1024,
          lookup: (_host, _opts, callback) => {
            if (typeof _opts === "object" && _opts.all) callback(null, [{ address, family: 4 }]);
            else callback(null, address, 4);
          },
        });
        let failBody: ((error: Error) => void) | undefined;
        const fail = (error = new McpBoundaryError("upstream_unavailable")) => {
          reject(error);
          failBody?.(error);
          req.destroy();
        };
        const abort = () =>
          fail(
            new McpBoundaryError(signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled"),
          );
        signal.addEventListener("abort", abort, { once: true });
        req.once("close", () => signal.removeEventListener("abort", abort));
        req.once("error", () => fail());
        req.once("response", (res) => {
          const status = res.statusCode ?? 502;
          const declared = Number(res.headers["content-length"] ?? 0);
          const encoding = res.headers["content-encoding"];
          if (
            (status >= 300 && status < 400) ||
            (encoding && encoding !== "identity") ||
            !Number.isFinite(declared) ||
            declared < 0 ||
            declared > options.maximumBytes
          ) {
            res.destroy();
            fail();
            return;
          }
          let closed = false;
          let bytes = 0;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              failBody = (error) => {
                if (!closed) {
                  closed = true;
                  controller.error(error);
                  res.destroy();
                }
              };
              res.on("data", (chunk: Buffer) => {
                bytes += chunk.byteLength;
                if (bytes > options.maximumBytes) {
                  fail(new McpBoundaryError("response_too_large"));
                  return;
                }
                if (!closed) {
                  controller.enqueue(chunk);
                  if ((controller.desiredSize ?? 0) <= 0) res.pause();
                }
              });
              res.once("end", () => {
                if (!closed) {
                  closed = true;
                  controller.close();
                }
              });
              res.once("error", () => fail());
              res.once("close", () => {
                if (!res.complete) fail();
              });
            },
            pull() {
              res.resume();
            },
            cancel() {
              closed = true;
              res.destroy();
              req.destroy();
            },
          });
          const outputHeaders = new Headers();
          for (const name of ["content-type", "mcp-session-id", "mcp-protocol-version"])
            if (typeof res.headers[name] === "string") outputHeaders.set(name, res.headers[name]);
          if ([204, 205, 304].includes(status)) {
            void stream.cancel();
            resolve(new Response(null, { status, headers: outputHeaders }));
          } else resolve(new Response(stream, { status, headers: outputHeaders }));
        });
        if (signal.aborted) abort();
        else req.end(body);
      });
    } catch (error) {
      if (error instanceof McpBoundaryError) throw error;
      throw new McpBoundaryError("upstream_unavailable");
    }
  };
}
