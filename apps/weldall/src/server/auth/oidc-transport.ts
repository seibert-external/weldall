import { request } from "node:https";
import { httpsUrl, LoginError } from "./oidc-config";

export async function oidcJson(
  urlValue: string,
  options: { body?: URLSearchParams; authorization?: string | undefined } = {},
): Promise<Record<string, unknown>> {
  const url = new URL(httpsUrl(urlValue));
  const body = options.body?.toString();
  return new Promise((resolve, reject) => {
    const fail = () => reject(new LoginError("upstream_unavailable"));
    const req = request(
      url,
      {
        method: body ? "POST" : "GET",
        agent: false,
        rejectUnauthorized: true,
        headers: {
          accept: "application/json",
          ...(body
            ? {
                "content-type": "application/x-www-form-urlencoded",
                "content-length": Buffer.byteLength(body),
              }
            : {}),
          ...(options.authorization ? { authorization: options.authorization } : {}),
        },
      },
      (response) => {
        if (
          response.statusCode !== 200 ||
          !/^application\/(?:[\w.+-]*\+)?json(?:;|$)/i.test(response.headers["content-type"] ?? "")
        ) {
          response.destroy();
          req.destroy();
          fail();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 256 * 1024) {
            response.destroy();
            req.destroy();
            fail();
          } else chunks.push(chunk);
        });
        response.on("error", fail);
        response.on("end", () => {
          try {
            const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
            resolve(result as Record<string, unknown>);
          } catch {
            fail();
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      fail();
    }, 8000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", fail);
    req.end(body);
  });
}
