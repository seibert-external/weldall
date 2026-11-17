import type { AuditReasonCode } from "../../lib/audit";
import { isAppRepositoryReady } from "../app-registry/service";
import type { ConnectorActor } from "../connectors/contracts";
import { ConnectorError } from "../connectors/errors";
import { openGitHost } from "../connectors/core/git-hosts";
import {
  writeGitFetchAudit,
  writeGitPushAudit,
  writeGitPushForwardedAudit,
  type GitRefUpdate,
} from "../connectors/git-audit";
import type { GitForwardingTarget, GitHost, GitRepositoryRef } from "../connectors/git-host";
import { privateHeaders } from "../connectors/http";
import { errorForLog, logger } from "../observability/logger";
import { requestIdentifiers } from "../observability/http";
import { verifyGitCredential } from "./credentials";
import {
  createTransferLimiter,
  GIT_PROXY_LIMITS,
  type GitProxyLimits,
  type TransferLimiter,
} from "./limits";
import { parseGitProxyRequest, type GitService } from "./paths";
import {
  advertisementError,
  createReceivePackResultReader,
  GitProtocolError,
  PktLineReader,
  readReceivePackRequest,
  receivePackRejection,
  usesSideBand,
  type ReceivePackRequest,
} from "./pkt-line";
import { resolveGitApp } from "./resolve";
import {
  branchOf,
  checkPushRules,
  GIT_PUSH_REASONS,
  pullRequestRejection,
  rejectAll,
  type RefRejection,
} from "./rules";

/**
 * Weldall's git proxy: serves git's smart HTTP protocol for app repositories and forwards it to
 * the Git host, so the host's token never leaves the server. Per request it checks the short-lived
 * git credential, resolves the app through the registry, enforces the push rules on the ref update
 * commands before forwarding anything, and streams both directions without buffering. Everything
 * host-specific (target URL, upstream authorization, pull request state) comes from the `GitHost`.
 */

const REALM = 'Basic realm="Weldall Git", charset="UTF-8"';
/** Request headers git needs upstream. Never the client's Authorization or cookies. */
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "git-protocol", "user-agent"];

export interface GitProxyOptions {
  openHost?: (input: { connectorId: string }) => Promise<GitHost>;
  limits?: Partial<GitProxyLimits>;
  limiter?: TransferLimiter;
}

/** Why a transfer stopped early; becomes the audit reason and the HTTP answer. */
class TransferStopped extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function textResponse(status: number, message: string, headers: Record<string, string> = {}) {
  return new Response(`${message}\n`, {
    status,
    headers: { ...privateHeaders, "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

function unauthorized() {
  return textResponse(401, "Authentication required.", { "www-authenticate": REALM });
}

/** The password of a Basic Authorization header, or null; git never sends credentials first. */
function basicPassword(header: string | null): string | null {
  const match = /^Basic ([A-Za-z0-9+/=]{1,4096})$/i.exec(header?.trim() ?? "");
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon < 0 ? null : decoded.slice(colon + 1);
}

/** Waits for `promise` unless `signal` fires first; `onAbort` releases what the promise holds. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => void) {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      onAbort();
      reject(signal.reason);
      return;
    }
    const abort = () => {
      onAbort();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Passes `source` through unchanged while counting bytes. Above `limit` it stops with `tooLarge`;
 * `onEnd` runs once with the outcome (end, error, or cancellation by the consumer).
 */
function counted(
  source: ReadableStream<Uint8Array>,
  {
    limit,
    tooLarge,
    onChunk,
    onEnd,
  }: {
    limit: number;
    tooLarge: TransferStopped;
    onChunk?: (chunk: Uint8Array) => void;
    onEnd?: (result: { bytes: number; error: unknown }) => void;
  },
) {
  const reader = source.getReader();
  let bytes = 0;
  let ended = false;
  let failure: unknown = null;
  const end = (error: unknown) => {
    if (ended) return;
    ended = true;
    failure = error;
    onEnd?.({ bytes, error });
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          end(null);
          controller.close();
          return;
        }
        bytes += value.length;
        if (bytes > limit) {
          await reader.cancel(tooLarge).catch(() => {});
          end(tooLarge);
          controller.error(tooLarge);
          return;
        }
        onChunk?.(value);
        controller.enqueue(value);
      } catch (error) {
        end(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      end(reason ?? new TransferStopped("The client closed the connection.", 499));
      await reader.cancel(reason).catch(() => {});
    },
  });
  return { stream, bytes: () => bytes, failure: () => failure };
}

export function createGitProxy(options: GitProxyOptions = {}) {
  const limits: GitProxyLimits = { ...GIT_PROXY_LIMITS, ...options.limits };
  const limiter = options.limiter ?? createTransferLimiter(limits);
  const openHost = options.openHost ?? openGitHost;

  return async function handleGitRequest(request: Request): Promise<Response> {
    const started = performance.now();
    const parsed = parseGitProxyRequest(request.method, new URL(request.url));
    // Dumb-protocol paths, other services and malformed paths are not served at all.
    if (!parsed) return textResponse(404, "Not found.");
    const { repository: path, endpoint } = parsed;
    const { service } = endpoint;
    const isPush = service === "git-receive-pack";

    const password = basicPassword(request.headers.get("authorization"));
    // Git always asks without credentials first; this 401 is not a rejection worth auditing.
    if (password === null) return unauthorized();
    const check = await verifyGitCredential(password);
    if (check.status === "invalid") {
      logger.warn(
        { event: "git_proxy.credential_invalid", service, connectorKey: path.connectorKey },
        "Git proxy request with an invalid credential",
      );
      return unauthorized();
    }
    const { credential } = check;
    const actor: ConnectorActor = {
      type: "user",
      id: credential.userId,
      email: credential.email,
      ...requestIdentifiers(request),
    };

    interface Target {
      connectorId: string;
      appId: string;
      repository: GitRepositoryRef;
    }
    let target: Target | null = null;
    let refUpdates: GitRefUpdate[] | undefined;
    const elapsed = () => performance.now() - started;

    const audit = async (
      entry:
        | {
            outcome: "success";
            requestBytes: number;
            responseBytes: number;
            upstreamStatus: number;
          }
        | {
            outcome: "denied" | "failed";
            reason: string;
            reasonCode?: AuditReasonCode;
            requestBytes?: number;
            responseBytes?: number;
            upstreamStatus?: number;
          },
    ) => {
      const transfer = {
        credentialId: credential.id,
        durationMs: elapsed(),
        ...(entry.requestBytes === undefined ? {} : { requestBytes: entry.requestBytes }),
        ...(entry.responseBytes === undefined ? {} : { responseBytes: entry.responseBytes }),
        ...(entry.upstreamStatus === undefined ? {} : { upstreamStatus: entry.upstreamStatus }),
      };
      try {
        if (entry.outcome === "success") {
          if (!target) throw new Error("Completed git transfer without a target.");
          const completed = {
            actor,
            outcome: "success" as const,
            ...target,
            ...transfer,
            requestBytes: entry.requestBytes,
            responseBytes: entry.responseBytes,
            upstreamStatus: entry.upstreamStatus,
          };
          await (isPush
            ? writeGitPushAudit({ ...completed, refUpdates: refUpdates ?? [] })
            : writeGitFetchAudit(completed));
          return;
        }
        const rejected = {
          actor,
          outcome: entry.outcome,
          reason: entry.reason,
          ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}),
          connectorId: target?.connectorId ?? null,
          appId: target?.appId ?? credential.appId,
          repository: target?.repository ?? null,
          ...transfer,
        };
        await (isPush
          ? writeGitPushAudit({ ...rejected, ...(refUpdates ? { refUpdates } : {}) })
          : writeGitFetchAudit(rejected));
      } catch (error) {
        // The audit store is the database the credential was just read from; if it fails now,
        // keep the entry in the log so the transfer stays attributable.
        logger.error(
          {
            event: "git_proxy.audit_failed",
            service,
            outcome: entry.outcome,
            actorId: actor.id,
            requestId: actor.requestId,
            credentialId: credential.id,
            appId: target?.appId ?? credential.appId,
            refUpdates,
            error: errorForLog(error),
          },
          "Writing the git proxy audit entry failed",
        );
      }
    };

    /** Refuses in the form git shows best for this endpoint, after auditing the refusal. */
    const refuse = async (
      message: string,
      {
        status = 403,
        outcome = "denied",
        reasonCode,
        headers,
        upstreamStatus,
      }: {
        status?: number;
        outcome?: "denied" | "failed";
        reasonCode?: AuditReasonCode;
        headers?: Record<string, string>;
        upstreamStatus?: number;
      } = {},
    ) => {
      await audit({
        outcome,
        reason: message,
        ...(reasonCode ? { reasonCode } : {}),
        ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
      });
      const text = `weldall: ${message}`;
      if (endpoint.kind === "advertisement" && status !== 429 && status !== 503)
        return new Response(new Uint8Array(advertisementError(service, text)), {
          status: 200,
          headers: { ...privateHeaders, "content-type": `application/x-${service}-advertisement` },
        });
      return textResponse(status, text, headers);
    };

    if (check.status === "expired") {
      await audit({
        outcome: "denied",
        reason: "The git credential has expired.",
        reasonCode: "invalid_grant",
      });
      return unauthorized();
    }
    if (isPush && credential.access !== "write")
      return refuse("this git credential is read-only and cannot push", {
        reasonCode: "scope_not_granted",
      });

    const resolved = await resolveGitApp(path);
    if (!resolved || resolved.app.id !== credential.appId)
      return refuse("this git credential is not valid for this repository");
    const { app, connector } = resolved;
    target = {
      connectorId: app.connectorId,
      appId: app.id,
      repository: { owner: app.repositoryOwner, name: app.repositoryName },
    };
    if (app.ownerId !== credential.userId)
      return refuse("this app belongs to another person", { reasonCode: "scope_not_granted" });
    if (!isAppRepositoryReady(app))
      return refuse("the app's repository is still being created", { status: 409 });
    if (!connector.enabled) return refuse("the Git host connector is disabled", { status: 409 });

    const slot = limiter.acquire(credential.userId);
    if ("refused" in slot)
      return refuse(
        slot.refused === "user"
          ? "too many git transfers of yours are running; retry shortly"
          : "too many git transfers are running; retry shortly",
        {
          status: slot.refused === "user" ? 429 : 503,
          headers: { "retry-after": String(limits.retryAfterSeconds) },
        },
      );

    const deadline = AbortSignal.timeout(limits.transferTimeoutMs);
    const signal = AbortSignal.any([request.signal, deadline]);
    const stopReason = () =>
      deadline.aborted
        ? new TransferStopped(
            `the transfer took longer than ${Math.round(limits.transferTimeoutMs / 1000)} s and was stopped`,
            408,
          )
        : new TransferStopped("the client closed the connection", 499);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      slot.release();
    };
    // A response nobody reads any more must not hold its slot past the deadline. A client abort
    // does not release it: a forwarded push keeps reading the host's result after the client left.
    deadline.addEventListener("abort", release, { once: true });
    /** Set when a streamed response took over the slot; it releases the slot when it ends. */
    let handedOff = false;

    try {
      const host = await openHost({ connectorId: app.connectorId });
      const forwardingTarget = (access: "read" | "write") =>
        host.getForwardingTarget({ repository: target!.repository, access }, signal);

      if (endpoint.kind === "advertisement") {
        const forwarding = await forwardingTarget(isPush ? "write" : "read");
        const upstream = await forward({
          request,
          forwarding,
          path: `info/refs?service=${service}`,
          body: null,
          signal,
        });
        if (upstream.status !== 200) {
          await upstream.body?.cancel().catch(() => {});
          return await refuse(`the Git host answered HTTP ${upstream.status}`, {
            status: 502,
            outcome: "failed",
            upstreamStatus: upstream.status,
          });
        }
        return relay(upstream, service, "advertisement", {
          limit: limits.fetchMaxBytes,
          onEnd: release,
        });
      }

      const contentType = request.headers.get("content-type")?.split(";")[0]?.trim();
      if (contentType !== `application/x-${service}-request` || !request.body)
        return await refuse("expected a git smart HTTP request", { status: 415 });
      const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();

      if (!isPush) {
        let body: ReadableStream<Uint8Array> = request.body;
        // Protocol v2 lists refs with an upload-pack POST; like info/refs it is not a fetch.
        let listsRefs = false;
        if (!encoding || encoding === "identity") {
          const reader = new PktLineReader(body.getReader(), 1024);
          try {
            const first = await untilAborted(reader.next(), signal, () => {});
            listsRefs = first !== "flush" && first.toString("utf8") === "command=ls-refs\n";
          } catch (error) {
            if (signal.aborted) throw error;
            // Not a v2 command line: forward unchanged, the host judges the request.
          }
          body = reader.replay();
        }
        const requestBody = counted(body, {
          limit: limits.pushMaxBytes,
          tooLarge: new TransferStopped("the fetch request exceeds the size limit", 413),
        });
        const forwarding = await forwardingTarget("read");
        const upstream = await forward({
          request,
          forwarding,
          path: service,
          body: requestBody.stream,
          encoding,
          signal,
        });
        if (upstream.status !== 200) {
          await upstream.body?.cancel().catch(() => {});
          return await refuse(`the Git host answered HTTP ${upstream.status}`, {
            status: 502,
            outcome: "failed",
            upstreamStatus: upstream.status,
          });
        }
        return relay(upstream, service, "result", {
          limit: limits.fetchMaxBytes,
          onEnd: ({ bytes, error }) => {
            release();
            if (listsRefs && !error) return;
            void audit(
              error
                ? {
                    outcome: "failed",
                    reason: describe(error, signal, stopReason),
                    requestBytes: requestBody.bytes(),
                    responseBytes: bytes,
                    upstreamStatus: upstream.status,
                  }
                : {
                    outcome: "success",
                    requestBytes: requestBody.bytes(),
                    responseBytes: bytes,
                    upstreamStatus: upstream.status,
                  },
            );
          },
        });
      }

      // Push: read the ref update commands before anything reaches the host.
      if (encoding && encoding !== "identity")
        return await refuse("compressed push requests are not supported", { status: 415 });
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > limits.pushMaxBytes)
        return await refuse(pushTooLarge(limits), { status: 413 });
      const reader = new PktLineReader(request.body.getReader(), limits.commandListMaxBytes);
      let push: ReceivePackRequest;
      try {
        push = await untilAborted(readReceivePackRequest(reader), signal, () => reader.cancel());
      } catch (error) {
        if (!(error instanceof GitProtocolError)) throw error;
        reader.cancel();
        return await refuse(error.message, { status: error.code === "too_large" ? 413 : 400 });
      }
      refUpdates = push.commands.map(({ ref, oldId, newId }) => ({
        ref,
        oldCommit: oldId,
        newCommit: newId,
      }));

      let rejections = checkPushRules(push, app.defaultBranch);
      let lookupFailed = false;
      if (!rejections) {
        const reasons = await Promise.all(
          push.commands.map(async ({ ref }) => {
            try {
              return pullRequestRejection(
                await host.readBranchPullRequestState(
                  { repository: target!.repository, branch: branchOf(ref)! },
                  signal,
                ),
              );
            } catch (error) {
              if (signal.aborted) throw error;
              lookupFailed = true;
              logger.warn(
                {
                  event: "git_proxy.pull_request_lookup_failed",
                  appId: app.id,
                  error: errorForLog(error),
                },
                "Checking the pull request state of a pushed branch failed",
              );
              return GIT_PUSH_REASONS.pullRequestUnknown;
            }
          }),
        );
        rejections = rejectAll(push.commands, reasons);
      }
      if (rejections)
        return await rejectPush({
          push,
          rejections,
          body: reader.replay(),
          limit: limits.pushMaxBytes,
          signal,
          stopReason,
          outcome: lookupFailed ? "failed" : "denied",
          audit,
          tooLarge: pushTooLarge(limits),
        });

      const forwarding = await forwardingTarget("write");
      // Every push the host may apply is attributable: without this entry nothing is forwarded.
      try {
        await writeGitPushForwardedAudit({
          actor,
          ...target,
          credentialId: credential.id,
          refUpdates,
        });
      } catch (error) {
        logger.error(
          { event: "git_proxy.audit_unavailable", appId: app.id, error: errorForLog(error) },
          "Refusing a push because its audit entry could not be written",
        );
        return await rejectPush({
          push,
          rejections: push.commands.map(({ ref }) => ({
            ref,
            reason: GIT_PUSH_REASONS.auditUnavailable,
          })),
          body: reader.replay(),
          limit: limits.pushMaxBytes,
          signal,
          stopReason,
          outcome: "failed",
          audit,
          tooLarge: pushTooLarge(limits),
        });
      }
      const requestBody = counted(reader.replay(), {
        limit: limits.pushMaxBytes,
        tooLarge: new TransferStopped(pushTooLarge(limits), 413),
      });
      let upstream: Response;
      try {
        // Bound only by the deadline: once the body is with the host, the host decides, and the
        // proxy reads its result even if the client goes away. A client abort during the upload
        // still ends the request, because the body stream fails.
        upstream = await forward({
          request,
          forwarding,
          path: service,
          body: requestBody.stream,
          signal: deadline,
        });
      } catch (error) {
        const failure = requestBody.failure();
        const stopped =
          failure instanceof TransferStopped ? failure : describeStop(error, signal, stopReason);
        if (!stopped) throw error;
        await audit({
          outcome: "failed",
          reason: stopped.message,
          requestBytes: requestBody.bytes(),
        });
        return textResponse(stopped.status, `weldall: ${stopped.message}`);
      }
      if (upstream.status !== 200) {
        await upstream.body?.cancel().catch(() => {});
        return await refuse(`the Git host answered HTTP ${upstream.status}`, {
          status: 502,
          outcome: "failed",
          upstreamStatus: upstream.status,
        });
      }
      const resultReader = createReceivePackResultReader(usesSideBand(push.capabilities));
      return relayToEnd(upstream, {
        limit: PUSH_RESULT_MAX_BYTES,
        onChunk: (chunk) => resultReader.push(chunk),
        onEnd: ({ bytes, error }) => {
          release();
          const result = error ? null : resultReader.result();
          const refused = result?.refs.filter(({ ok }) => !ok) ?? [];
          const transfer = {
            requestBytes: requestBody.bytes(),
            responseBytes: bytes,
            upstreamStatus: upstream.status,
          };
          void audit(
            result && result.unpack === "ok" && !refused.length
              ? { outcome: "success", ...transfer }
              : {
                  outcome: "failed",
                  reason: error
                    ? describe(error, deadline, stopReason)
                    : !result
                      ? "The Git host's push result could not be read."
                      : result.unpack !== "ok"
                        ? `The Git host could not unpack the push: ${result.unpack}`
                        : `The Git host refused: ${refused.map(({ ref, reason }) => `${ref} (${reason})`).join(", ")}`,
                  ...transfer,
                },
          );
        },
      });
    } catch (error) {
      const stopped = describeStop(error, signal, stopReason);
      if (stopped) {
        await audit({ outcome: "failed", reason: stopped.message });
        return textResponse(stopped.status, `weldall: ${stopped.message}`);
      }
      if (error instanceof ConnectorError)
        return await refuse(error.message, {
          status: error.status >= 500 ? 503 : 502,
          outcome: "failed",
        });
      logger.error(
        { event: "git_proxy.failed", service, appId: app.id, error: errorForLog(error) },
        "Git proxy request failed",
      );
      return await refuse("the request failed unexpectedly", { status: 502, outcome: "failed" });
    } finally {
      if (!handedOff) release();
    }

    /**
     * Streams a push result to the client and keeps reading it to the end when the client goes
     * away, so the audit records what the host actually did. The result is progress plus a short
     * status report (bounded by {@link PUSH_RESULT_MAX_BYTES}), so it is not throttled to the client.
     */
    function relayToEnd(
      upstream: Response,
      {
        limit,
        onChunk,
        onEnd,
      }: {
        limit: number;
        onChunk: (chunk: Uint8Array) => void;
        onEnd: (result: { bytes: number; error: unknown }) => void;
      },
    ) {
      handedOff = true;
      let downstream: ReadableStreamDefaultController<Uint8Array> | null = null;
      let open = true;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          downstream = controller;
        },
        cancel() {
          open = false;
        },
      });
      const reader = (
        upstream.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })
      ).getReader();
      void (async () => {
        let bytes = 0;
        let error: unknown = null;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > limit) {
              error = new TransferStopped("the Git host's push result exceeds the size limit", 502);
              await reader.cancel(error).catch(() => {});
              break;
            }
            onChunk(value);
            if (open)
              try {
                downstream!.enqueue(value);
              } catch {
                open = false;
              }
          }
        } catch (caught) {
          error = caught;
        }
        if (open)
          try {
            if (error) downstream!.error(error);
            else downstream!.close();
          } catch {
            // The client is gone.
          }
        onEnd({ bytes, error });
      })();
      return new Response(stream, {
        status: 200,
        headers: { ...privateHeaders, "content-type": "application/x-git-receive-pack-result" },
      });
    }

    function relay(
      upstream: Response,
      gitService: GitService,
      kind: "advertisement" | "result",
      {
        limit,
        onChunk,
        onEnd,
      }: {
        limit: number;
        onChunk?: (chunk: Uint8Array) => void;
        onEnd: (result: { bytes: number; error: unknown }) => void;
      },
    ) {
      handedOff = true;
      const body = upstream.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
      const { stream } = counted(body, {
        limit,
        tooLarge: new TransferStopped("the response exceeds the size limit", 502),
        ...(onChunk ? { onChunk } : {}),
        onEnd,
      });
      return new Response(stream, {
        status: 200,
        headers: { ...privateHeaders, "content-type": `application/x-${gitService}-${kind}` },
      });
    }
  };
}

/** Progress plus status report of one push; far above what a real push result needs. */
const PUSH_RESULT_MAX_BYTES = 16 * 1024 * 1024;

const pushTooLarge = ({ pushMaxBytes }: GitProxyLimits) =>
  `the push exceeds the ${
    pushMaxBytes >= 1024 * 1024
      ? `${Math.round(pushMaxBytes / (1024 * 1024))} MB`
      : `${Math.round(pushMaxBytes / 1024)} KB`
  } limit`;

/** The early stop behind `error`, if the transfer was stopped rather than broken. */
function describeStop(
  error: unknown,
  signal: AbortSignal,
  stopReason: () => TransferStopped,
): TransferStopped | null {
  if (signal.aborted) return stopReason();
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (current instanceof TransferStopped) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function describe(error: unknown, signal: AbortSignal, stopReason: () => TransferStopped) {
  return (
    describeStop(error, signal, stopReason)?.message ??
    (error instanceof Error ? error.message : "The transfer failed.")
  );
}

/** Forwards one smart-HTTP request to the host with the host's authorization. */
function forward({
  request,
  forwarding,
  path,
  body,
  encoding,
  signal,
}: {
  request: Request;
  forwarding: GitForwardingTarget;
  path: string;
  body: ReadableStream<Uint8Array> | null;
  encoding?: string | undefined;
  signal: AbortSignal;
}) {
  if (forwarding.expiresAt && forwarding.expiresAt.getTime() <= Date.now())
    throw new ConnectorError("upstream_unavailable", "The Git host's token has expired.", 503);
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (encoding) headers.set("content-encoding", encoding);
  headers.set("authorization", forwarding.authorization);
  const init: RequestInit & { duplex?: "half" } = {
    method: body ? "POST" : "GET",
    headers,
    redirect: "manual",
    signal,
    ...(body ? { body, duplex: "half" } : {}),
  };
  return fetch(`${forwarding.url.href.replace(/\/$/, "")}/${path}`, init);
}

/**
 * Answers a refused push with a receive-pack result, so git shows
 * `! [remote rejected] <ref> (<reason>)`. The rest of the body is read and discarded first: a
 * client still sending would otherwise see a broken connection instead of the result (behind
 * nginx with HTTP/2 this is what worked in the spike). Draining stops at the push size limit.
 */
async function rejectPush({
  push,
  rejections,
  body,
  limit,
  signal,
  stopReason,
  outcome,
  audit,
  tooLarge,
}: {
  push: ReceivePackRequest;
  rejections: RefRejection[];
  body: ReadableStream<Uint8Array>;
  limit: number;
  signal: AbortSignal;
  stopReason: () => TransferStopped;
  outcome: "denied" | "failed";
  audit: (entry: {
    outcome: "denied" | "failed";
    reason: string;
    requestBytes?: number;
  }) => Promise<void>;
  tooLarge: string;
}): Promise<Response> {
  const reader = body.getReader();
  let bytes = 0;
  const reason = rejections
    .filter(({ reason: text }) => text !== GIT_PUSH_REASONS.otherRefRejected)
    .map(({ ref, reason: text }) => `${ref}: ${text}`)
    .join("; ");
  try {
    for (;;) {
      const { value, done } = await untilAborted(reader.read(), signal, () => {
        void reader.cancel().catch(() => {});
      });
      if (done) break;
      bytes += value.length;
      if (bytes > limit) {
        await reader.cancel().catch(() => {});
        await audit({ outcome, reason: `${reason}; ${tooLarge}`, requestBytes: bytes });
        return textResponse(413, `weldall: ${tooLarge}`);
      }
    }
  } catch (error) {
    const stopped = describeStop(error, signal, stopReason) ?? stopReason();
    await audit({ outcome, reason: `${reason}; ${stopped.message}`, requestBytes: bytes });
    return textResponse(stopped.status, `weldall: ${stopped.message}`);
  }
  await audit({ outcome, reason, requestBytes: bytes });
  const result = receivePackRejection(push.capabilities, rejections);
  if (!result) return textResponse(403, rejections[0]!.reason);
  return new Response(new Uint8Array(result), {
    status: 200,
    headers: { ...privateHeaders, "content-type": "application/x-git-receive-pack-result" },
  });
}
