import { createServer, type ServerResponse } from "node:http";
import { safeEqual } from "@weldall/sdk";

export interface LoopbackCallback {
  redirectUri: string;
  code: Promise<string>;
  /** Stops listening and ends open connections; rejects `code` if it is still pending. */
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
  let accepted: string | undefined;
  let timer: NodeJS.Timeout;

  const code = new Promise<string>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // Answers with "connection: close", so the server ends the socket once the answer is flushed.
  const answer = (response: ServerResponse, url: URL) => {
    response.shouldKeepAlive = false;
    response.setHeader("connection", "close");
    if (url.searchParams.has("error")) response.writeHead(400).end("Authorization failed");
    else
      response
        .writeHead(303, { location: new URL("/login/complete", expectedIssuer).toString() })
        .end();
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // Browsers can request the accepted callback a second time, e.g. when the consent page
    // navigates twice. Answer it again until login finishes instead of leaving a closed port.
    if (request.method === "GET" && url.pathname === "/callback" && url.search === accepted) {
      answer(response, url);
      return;
    }
    const states = url.searchParams.getAll("state");
    const issuers = url.searchParams.getAll("iss");
    const codes = url.searchParams.getAll("code");
    const errors = url.searchParams.getAll("error");
    const descriptions = url.searchParams.getAll("error_description");
    const hasSingleResult =
      (codes.length === 1 && errors.length === 0) || (codes.length === 0 && errors.length === 1);
    const hasValidErrorDescription =
      descriptions.length <= 1 && (descriptions.length === 0 || errors.length === 1);
    if (
      settled ||
      request.method !== "GET" ||
      url.pathname !== "/callback" ||
      states.length !== 1 ||
      !states[0] ||
      !safeEqual(states[0], state) ||
      issuers.length !== 1 ||
      issuers[0] !== expectedIssuer ||
      !hasSingleResult ||
      !hasValidErrorDescription
    ) {
      response.writeHead(400).end("Invalid callback");
      return;
    }

    settled = true;
    accepted = url.search;
    clearTimeout(timer);
    answer(response, url);
    if (errors.length === 1) {
      const error = errors[0] || "authorization failed";
      const description = descriptions[0];
      reject(new Error(description ? `${error}: ${description}` : error));
    } else resolve(codes[0]!);
  });

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback failed");

  const close = (error = new Error("login cancelled")) => {
    clearTimeout(timer);
    if (server.listening) server.close();
    server.closeAllConnections();
    if (settled) return;
    settled = true;
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
