import type { AppHostApp } from "@weldall/sdk";
import { authorizePerson } from "../access.js";
import { auditList, type AuditRejection, type AuditReport } from "../audit.js";
import { GitAppError } from "../errors.js";
import type { GitForwardingTarget, GitRepositoryRef } from "../hosts/git-host.js";
import { errorForLog } from "../log.js";
import type { GitAppServices } from "../services/context.js";
import { lookupApp } from "../weldall.js";
import type { GitCredentialSigner } from "./credentials.js";
import {
  createTransferLimiter,
  GIT_PROXY_LIMITS,
  type GitProxyLimits,
  type TransferLimiter,
} from "./limits.js";
import { parseGitProxyRequest, type GitService } from "./paths.js";
import {
  advertisementError,
  createReceivePackResultReader,
  GitProtocolError,
  PktLineReader,
  readReceivePackRequest,
  receivePackRejection,
  usesSideBand,
  type ReceivePackRequest,
} from "./pkt-line.js";
import {
  branchOf,
  checkPushRules,
  GIT_PUSH_REASONS,
  pullRequestRejection,
  rejectAll,
  type RefRejection,
} from "./rules.js";

/**
 * The Git app's git proxy: serves git's
 * smart HTTP protocol at `/git/<owner>/<repository>.git` and forwards it to the Git host, so the
 * host's token never leaves the Git app. Per request it
 *
 * 1. verifies the signed git credential (`credentials.ts`) and that it names this repository and,
 *    for a push, write access;
 * 2. asks Weldall, every time and without caching, whether the person still holds the login
 *    permission and the publish scope (`checkSubjectScopes`) and still owns the app
 *    (`lookupApp`); without an answer nothing is forwarded;
 * 3. for a push, reads the ref update commands before anything reaches the host, applies the
 *    push rules (`rules.ts`) and the pull request state, and forwards only after Weldall stored
 *    `git_push.forwarded`;
 * 4. streams both directions without buffering, within the limits of `limits.ts`, with a host
 *    token minted for this one repository and operation.
 *
 * Every refusal is reported to Weldall's audit (best effort), except git's first request without
 * credentials, which is how git always starts.
 */

const REALM = 'Basic realm="Weldall Git", charset="UTF-8"';
/** Request headers git needs upstream. Never the client's Authorization or cookies. */
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "git-protocol", "user-agent"];
const privateHeaders = { "cache-control": "no-store", pragma: "no-cache" } as const;

export interface GitProxyOptions {
  services: GitAppServices;
  signer: GitCredentialSigner;
  limits?: Partial<GitProxyLimits>;
  limiter?: TransferLimiter;
}

interface GitRefUpdate {
  ref: string;
  oldCommit: string;
  newCommit: string;
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
      end(reason ?? new TransferStopped("the client closed the connection", 499));
      await reader.cancel(reason).catch(() => {});
    },
  });
  return { stream, bytes: () => bytes, failure: () => failure };
}

const sameRepository = (a: GitRepositoryRef, b: GitRepositoryRef) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

export function createGitProxy({ services, signer, ...options }: GitProxyOptions) {
  const limits: GitProxyLimits = { ...GIT_PROXY_LIMITS, ...options.limits };
  const limiter = options.limiter ?? createTransferLimiter(limits);
  const { host, weldall, log } = services;

  return async function handleGitRequest(request: Request): Promise<Response> {
    const started = performance.now();
    const parsed = parseGitProxyRequest(request.method, new URL(request.url));
    // Dumb-protocol paths, other services and malformed paths are not served at all.
    if (!parsed) return textResponse(404, "Not found.");
    const { repository: path, endpoint } = parsed;
    const { service } = endpoint;
    const isPush = service === "git-receive-pack";
    const requested: GitRepositoryRef = { owner: path.owner, name: path.name };

    const password = basicPassword(request.headers.get("authorization"));
    // Git always asks without credentials first; this 401 is not a rejection worth auditing.
    if (password === null) return unauthorized();
    const check = signer.verify(password);
    const credential = check.status === "invalid" ? null : check.credential;

    /** Set once the app is resolved and owned by the credential's person. */
    let target: { appId: string; repository: GitRepositoryRef } | null = null;
    /**
     * The app a validly signed, unexpired credential for this repository names: rejections before
     * the app is resolved (a read-only push, a revoked scope) are linked to it. Cleared when the
     * lookup shows it is not this person's app here. Should Weldall no longer know it, the
     * reporter repeats the rejection without it (`AuditReporter.rejection`).
     */
    let credentialAppId: string | null = null;
    let refUpdates: GitRefUpdate[] | undefined;
    const durationMs = () => Math.round(performance.now() - started);

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
            reasonCode?: "invalid_request" | "invalid_grant" | "scope_not_granted";
            requestBytes?: number;
            responseBytes?: number;
            upstreamStatus?: number;
          },
    ) => {
      const refs = refUpdates ?? [];
      const refDetails = {
        refUpdates: auditList(refs, "refUpdates"),
        refUpdateCount: refs.length,
      };
      const credentialId = credential?.id ?? null;
      if (entry.outcome === "success") {
        if (!target || !credential) throw new Error("Completed git transfer without a target.");
        const transfer = {
          credentialId,
          requestBytes: entry.requestBytes,
          responseBytes: entry.responseBytes,
          durationMs: durationMs(),
          upstreamStatus: entry.upstreamStatus,
        };
        const report: AuditReport = isPush
          ? {
              eventType: "git_push.completed",
              subject: credential.subject,
              appId: target.appId,
              details: { ...refDetails, ...transfer },
            }
          : {
              eventType: "git_fetch.completed",
              subject: credential.subject,
              appId: target.appId,
              details: transfer,
            };
        try {
          await services.audit.success(report as Exclude<AuditReport, AuditRejection>);
        } catch {
          // The transfer happened; keep it attributable in the log.
          log("error", "git transfer happened but its audit entry was not stored", {
            eventType: report.eventType,
            subject: credential.subject,
            appId: target.appId,
            refUpdates: refDetails.refUpdates,
            ...transfer,
          });
        }
        return;
      }
      const partial = {
        credentialId,
        requestBytes: entry.requestBytes ?? null,
        responseBytes: entry.responseBytes ?? null,
        durationMs: durationMs(),
        upstreamStatus: entry.upstreamStatus ?? null,
      };
      // Another owner's app is never linked to this person's rejection.
      const appId = target?.appId ?? credentialAppId;
      const common = {
        subject: credential?.subject ?? null,
        // The contract takes either the app (Weldall records its repository) or the repository.
        appId,
        repository: appId ? null : requested,
        reason: entry.reason,
        ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}),
      };
      await services.audit.rejection(
        isPush
          ? {
              ...common,
              eventType: entry.outcome === "denied" ? "git_push.denied" : "git_push.failed",
              details: { ...refDetails, ...partial },
            }
          : {
              ...common,
              eventType: entry.outcome === "denied" ? "git_fetch.denied" : "git_fetch.failed",
              details: partial,
            },
        // Should Weldall no longer know the app, the requested repository is named instead.
        { repository: requested },
      );
    };

    if (check.status === "invalid") {
      // Not audited: anyone can send a made-up password, and the audit log must not be writable
      // without a credential this instance signed.
      log("warn", "git request with an invalid credential", {
        service,
        repository: `${path.owner}/${path.name}`,
      });
      return unauthorized();
    }
    if (check.status === "expired") {
      await audit({
        outcome: "denied",
        reason: "The git credential has expired.",
        reasonCode: "invalid_grant",
      });
      return unauthorized();
    }
    const { credential: verified } = check;

    /**
     * Set for a push once its command list is read: refusals then use git's per-ref report, until
     * the rest of the body is handed to the host (`forwarding`).
     */
    let push: { request: ReceivePackRequest; reader: PktLineReader; forwarding: boolean } | null =
      null;
    const deadline = AbortSignal.timeout(limits.transferTimeoutMs);
    const signal = AbortSignal.any([request.signal, deadline]);
    const stopReason = () =>
      deadline.aborted
        ? new TransferStopped(
            `the transfer took longer than ${Math.round(limits.transferTimeoutMs / 1000)} s and was stopped`,
            408,
          )
        : new TransferStopped("the client closed the connection", 499);

    /** Refuses in the form git shows best for this request, after auditing the refusal. */
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
        reasonCode?: "invalid_request" | "invalid_grant" | "scope_not_granted";
        headers?: Record<string, string>;
        upstreamStatus?: number;
      } = {},
    ): Promise<Response> => {
      const text = `weldall: ${message}`;
      // A push whose commands were read gets `! [remote rejected] <ref> (<reason>)` per ref.
      if (push && !push.forwarding && !headers)
        return rejectPush({
          push: push.request,
          rejections: push.request.commands.map(({ ref }) => ({ ref, reason: text })),
          body: push.reader.replay(),
          limit: limits.pushMaxBytes,
          signal,
          stopReason,
          outcome,
          audit: (entry) => audit({ ...entry, ...(reasonCode ? { reasonCode } : {}) }),
          tooLarge: pushTooLarge(limits),
        });
      if (push && !push.forwarding) push.reader.cancel();
      await audit({
        outcome,
        reason: message,
        ...(reasonCode ? { reasonCode } : {}),
        ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
      });
      // In the ref advertisement git shows `remote error: <message>`; a refusal that asks the
      // client to come back later (Retry-After) keeps its status instead.
      if (endpoint.kind === "advertisement" && !headers)
        return new Response(new Uint8Array(advertisementError(service, text)), {
          status: 200,
          headers: { ...privateHeaders, "content-type": `application/x-${service}-advertisement` },
        });
      return textResponse(status, text, headers);
    };

    if (!sameRepository(verified.repository, requested))
      return await refuse("this git credential is not valid for this repository");
    credentialAppId = verified.appId;
    // The credential is valid and the request well-formed; the access it grants (read) does not
    // include pushing, which is what `scope_not_granted` records.
    if (isPush && verified.access !== "write")
      return await refuse("this git credential is read-only and cannot push", {
        reasonCode: "scope_not_granted",
      });

    const slot = limiter.acquire(verified.subject);
    if ("refused" in slot)
      return await refuse(
        slot.refused === "user"
          ? "too many git transfers of yours are running; retry shortly"
          : "too many git transfers are running; retry shortly",
        {
          status: slot.refused === "user" ? 429 : 503,
          headers: { "retry-after": String(limits.retryAfterSeconds) },
        },
      );

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      slot.release();
    };
    // Taken before the command list is read or a refused push is drained, so a person cannot hold
    // more connections than the limits allow. A response nobody reads any more must not hold its
    // slot past the deadline. A client abort does not release it: a forwarded push keeps reading
    // the host's result after the client left.
    deadline.addEventListener("abort", release, { once: true });
    /** Set when a streamed response took over the slot; it releases the slot when it ends. */
    let handedOff = false;

    try {
      // A push's command list is read first (bounded by `commandListMaxBytes`), so that every later
      // refusal, including Weldall being unreachable, reaches git as a readable per-ref message.
      let encoding: string | undefined;
      if (endpoint.kind === "rpc") {
        const contentType = request.headers.get("content-type")?.split(";")[0]?.trim();
        if (contentType !== `application/x-${service}-request` || !request.body)
          return await refuse("expected a git smart HTTP request", { status: 415 });
        encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
        if (isPush) {
          if (encoding && encoding !== "identity")
            return await refuse("compressed push requests are not supported", { status: 415 });
          const declared = Number(request.headers.get("content-length") ?? "0");
          if (declared > limits.pushMaxBytes)
            return await refuse(pushTooLarge(limits), { status: 413 });
          const reader = new PktLineReader(request.body.getReader(), limits.commandListMaxBytes);
          try {
            const parsedPush = await untilAborted(readReceivePackRequest(reader), signal, () =>
              reader.cancel(),
            );
            push = { request: parsedPush, reader, forwarding: false };
          } catch (error) {
            reader.cancel();
            if (error instanceof GitProtocolError)
              return await refuse(error.message, {
                status: error.code === "too_large" ? 413 : 400,
              });
            const stopped = describeStop(error, signal, stopReason);
            if (!stopped) throw error;
            await audit({ outcome: "failed", reason: stopped.message });
            return textResponse(stopped.status, `weldall: ${stopped.message}`);
          }
          refUpdates = push.request.commands.map(({ ref, oldId, newId }) => ({
            ref,
            oldCommit: oldId,
            newCommit: newId,
          }));
        }
      }

      // Live checks with Weldall on every request: the credential alone is not enough.
      let app: AppHostApp;
      try {
        const [, found] = await Promise.all([
          authorizePerson(weldall, verified.subject, [services.scopes.publish]),
          lookupApp(weldall, {
            app: { repositoryOwner: path.owner, repositoryName: path.name },
            subject: verified.subject,
          }),
        ]);
        if (!found || found.app.id !== verified.appId) {
          credentialAppId = null;
          return await refuse("this git credential is not valid for this repository");
        }
        if (found.ownedBySubject !== true) {
          credentialAppId = null;
          return await refuse("this app belongs to another person", {
            reasonCode: "scope_not_granted",
          });
        }
        app = found.app;
      } catch (error) {
        if (!(error instanceof GitAppError)) throw error;
        return await refuse(
          error.message,
          error.status === 403
            ? { reasonCode: "scope_not_granted" }
            : { status: 503, outcome: "failed" },
        );
      }
      target = {
        appId: app.id,
        repository: { owner: app.repository.owner, name: app.repository.name },
      };
      if (app.repository.owner.toLowerCase() !== host.organization.toLowerCase())
        return await refuse("the app's repository is not in this Git app's organisation", {
          status: 409,
        });
      if (!app.ready)
        return await refuse("the app's repository is still being created", { status: 409 });

      try {
        const forwardingTarget = (access: "read" | "write") =>
          host.host.getForwardingTarget({ repository: target!.repository, access }, signal);

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

        if (!push) {
          let body: ReadableStream<Uint8Array> = request.body!;
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

        // Push: the commands were read above; nothing has reached the host yet.
        const { request: pushRequest, reader } = push;
        let rejections = checkPushRules(pushRequest, app.defaultBranch);
        let lookupFailed = false;
        if (!rejections) {
          const reasons = await Promise.all(
            pushRequest.commands.map(async ({ ref }) => {
              try {
                return pullRequestRejection(
                  await host.host.readBranchPullRequestState(
                    { repository: target!.repository, branch: branchOf(ref)! },
                    signal,
                  ),
                );
              } catch (error) {
                if (signal.aborted) throw error;
                lookupFailed = true;
                log("warn", "checking the pull request state of a pushed branch failed", {
                  appId: app.id,
                  ...errorForLog(error),
                });
                return GIT_PUSH_REASONS.pullRequestUnknown;
              }
            }),
          );
          rejections = rejectAll(pushRequest.commands, reasons);
        }
        if (rejections)
          return await rejectPush({
            push: pushRequest,
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
        // Every push the host may apply is attributable: unless Weldall stored this entry, nothing
        // is forwarded.
        const refs = refUpdates ?? [];
        try {
          await services.audit.success({
            eventType: "git_push.forwarded",
            subject: verified.subject,
            appId: app.id,
            details: {
              refUpdates: auditList(refs, "refUpdates"),
              refUpdateCount: refs.length,
              credentialId: verified.id,
            },
          });
        } catch (error) {
          log("error", "refusing a push because Weldall did not store its audit entry", {
            appId: app.id,
            ...errorForLog(error),
          });
          return await rejectPush({
            push: pushRequest,
            rejections: pushRequest.commands.map(({ ref }) => ({
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
        push.forwarding = true;
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
          await audit({
            outcome: "failed",
            reason: `the Git host answered HTTP ${upstream.status}`,
            requestBytes: requestBody.bytes(),
            upstreamStatus: upstream.status,
          });
          return textResponse(502, `weldall: the Git host answered HTTP ${upstream.status}`);
        }
        const resultReader = createReceivePackResultReader(usesSideBand(pushRequest.capabilities));
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
          if (push && !push.forwarding) push.reader.cancel();
          await audit({ outcome: "failed", reason: stopped.message });
          return textResponse(stopped.status, `weldall: ${stopped.message}`);
        }
        if (error instanceof GitAppError)
          return await refuse(error.message, {
            status: error.status >= 500 ? 503 : 502,
            outcome: "failed",
          });
        log("error", "git proxy request failed", { service, appId: app.id, ...errorForLog(error) });
        return await refuse("the request failed unexpectedly", { status: 502, outcome: "failed" });
      } finally {
        if (!handedOff) release();
      }
    } finally {
      // Every refusal before the inner block (awaited, so a drained push still holds the slot).
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
        onEnd,
      }: {
        limit: number;
        onEnd: (result: { bytes: number; error: unknown }) => void;
      },
    ) {
      handedOff = true;
      const body = upstream.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
      const { stream } = counted(body, {
        limit,
        tooLarge: new TransferStopped("the response exceeds the size limit", 502),
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
    throw new GitAppError("upstream_unavailable", "The Git host's token has expired.", 503);
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
 * client still sending would otherwise see a broken connection instead of the result. Draining
 * stops at the push size limit.
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
