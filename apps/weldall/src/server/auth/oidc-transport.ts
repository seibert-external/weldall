import type { CustomFetch } from "openid-client";
import { httpsUrl, LoginError } from "./oidc-config";

// Private HTTPS is permitted. This is a resource/TLS boundary, not an SSRF filter.
export const oidcFetch: CustomFetch = async (url, options) => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => {
    void reader?.cancel().catch(() => {});
  };
  try {
    const response = await fetch(httpsUrl(url), {
      ...options,
      body: (options.body as BodyInit | undefined) ?? null,
      redirect: "manual",
    });
    reader = response.body?.getReader();
    options.signal?.addEventListener("abort", abort, { once: true });
    options.signal?.throwIfAborted();
    if (
      (response.status >= 300 && response.status < 400) ||
      !/^application\/(?:[\w.+-]*\+)?json(?:;|$)/i.test(response.headers.get("content-type") ?? "")
    )
      throw new LoginError("upstream_unavailable");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw new LoginError("upstream_unavailable");
      chunks.push(value);
    }
    options.signal?.throwIfAborted();
    return new Response(Buffer.concat(chunks), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    await reader?.cancel().catch(() => {});
    throw new LoginError("upstream_unavailable");
  } finally {
    options.signal?.removeEventListener("abort", abort);
    reader?.releaseLock();
  }
};
