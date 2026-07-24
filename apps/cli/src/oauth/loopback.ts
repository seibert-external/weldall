import { createServer } from "node:http";
import { safeEqual } from "@weldall/oauth";

export interface LoopbackCallback {
  redirectUri: string;
  code: Promise<string>;
  close(error?: Error): void;
}

export async function loopback(
  state: string,
  expectedIssuer: string,
  timeoutMs = 120_000,
): Promise<LoopbackCallback> {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  let settled = false;
  let timer: NodeJS.Timeout;

  const code = new Promise<string>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const states = url.searchParams.getAll("state");
    const issuers = url.searchParams.getAll("iss");
    const codes = url.searchParams.getAll("code");
    const errors = url.searchParams.getAll("error");
    const hasSingleResult =
      (codes.length === 1 && errors.length === 0) || (codes.length === 0 && errors.length === 1);
    if (
      settled ||
      request.method !== "GET" ||
      url.pathname !== "/callback" ||
      states.length !== 1 ||
      !states[0] ||
      !safeEqual(states[0], state) ||
      issuers.length !== 1 ||
      issuers[0] !== expectedIssuer ||
      !hasSingleResult
    ) {
      response.writeHead(400).end("Invalid callback");
      return;
    }

    settled = true;
    clearTimeout(timer);
    if (errors.length === 1) {
      response.writeHead(400).end("Authorization failed");
      reject(new Error(errors[0] || "authorization failed"));
    } else {
      response.end("Weldall login complete. You may close this window.");
      resolve(codes[0]!);
    }
    server.close();
  });

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback failed");

  const close = (error = new Error("login cancelled")) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server.close();
    reject(error);
  };
  timer = setTimeout(() => close(new Error("login timed out")), timeoutMs);
  timer.unref();

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    code,
    close,
  };
}
