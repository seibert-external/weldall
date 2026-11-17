/**
 * Git pkt-line handling for the git proxy: reading the receive-pack command list from the front
 * of a streamed request body (the pack that follows is never parsed), and writing the protocol
 * replies the proxy sends itself. Reference: git's `gitprotocol-common` (pkt-line) and
 * `gitprotocol-pack` (reference update request, report-status, side-band).
 */

/** The request violates the git protocol, or the part the proxy must read is too large. */
export class GitProtocolError extends Error {
  constructor(
    message: string,
    readonly code: "malformed" | "too_large" = "malformed",
  ) {
    super(message);
  }
}

/** Largest pkt-line git writes (`LARGE_PACKET_MAX`). */
const MAX_PKT_LENGTH = 65_520;
const FLUSH = "flush" as const;

/**
 * Reads pkt-lines from the front of a byte stream. Every byte taken from the stream, including
 * bytes behind the last parsed line, is kept so {@link replay} can forward the body unchanged.
 * Reading stops with a {@link GitProtocolError} once the parsed lines would pass `maxBytes`.
 */
export class PktLineReader {
  private buffer = Buffer.alloc(0);
  private offset = 0;
  private ended = false;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly maxBytes: number,
  ) {}

  /** Bytes parsed so far. */
  get position() {
    return this.offset;
  }

  private async need(bytes: number) {
    if (this.offset + bytes > this.maxBytes)
      throw new GitProtocolError("The git command list is too large.", "too_large");
    while (this.buffer.length < this.offset + bytes) {
      const { value, done } = await this.reader.read();
      if (done) {
        this.ended = true;
        throw new GitProtocolError("The git request ended inside a pkt-line.");
      }
      this.buffer = Buffer.concat([this.buffer, value]);
    }
  }

  /** The next pkt-line payload, or `"flush"` for a flush-pkt. Other special packets are refused. */
  async next(): Promise<Buffer | typeof FLUSH> {
    await this.need(4);
    const header = this.buffer.subarray(this.offset, this.offset + 4).toString("latin1");
    if (!/^[0-9a-f]{4}$/i.test(header)) throw new GitProtocolError("Invalid pkt-line length.");
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      this.offset += 4;
      return FLUSH;
    }
    if (length < 4 || length > MAX_PKT_LENGTH)
      throw new GitProtocolError("Unexpected pkt-line length.");
    await this.need(length);
    const payload = this.buffer.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return payload;
  }

  /** Stops reading; the rest of the body is discarded. */
  cancel(reason?: unknown) {
    void this.reader.cancel(reason).catch(() => {});
  }

  /** The whole body again: the bytes read so far, then the rest of the stream. */
  replay(): ReadableStream<Uint8Array> {
    const { reader } = this;
    let head: Buffer | null = this.buffer;
    const ended = this.ended;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (head) {
          const chunk = head;
          head = null;
          if (chunk.length) {
            controller.enqueue(new Uint8Array(chunk));
            return;
          }
        }
        if (ended) {
          controller.close();
          return;
        }
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }
}

export interface RefUpdateCommand {
  oldId: string;
  newId: string;
  /** Full ref name, e.g. `refs/heads/main`. */
  ref: string;
}

export interface ReceivePackRequest {
  commands: RefUpdateCommand[];
  /** As sent: `name` or `name=value`, separated by single spaces. */
  capabilities: string[];
  /** Signed push (`push-cert`); its commands are inside the certificate and are not parsed. */
  pushCert: boolean;
  pushOptions: string[];
}

const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/**
 * Ref names are checked by the rules; here only what would break the line format is refused. The
 * name is kept byte for byte (latin1, no trimming), so the name checked, audited and forwarded is
 * the same.
 */
const refName = /^[^\u0000- \u007f]+$/;
/**
 * Git matches capabilities after any whitespace and ignores an `=value` suffix when it looks one
 * up, so anything but printable ASCII separated by single spaces could hide a capability from the
 * proxy (e.g. `push-options` behind a tab). Such lists are refused outright.
 */
const capabilityList = /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/;

function text(payload: Buffer, encoding: BufferEncoding = "utf8") {
  const line = payload.toString(encoding);
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

function parseCapabilities(raw: string): string[] {
  // Git 2.39 writes one space between the NUL and the first capability.
  const list = raw.startsWith(" ") ? raw.slice(1) : raw;
  if (list === "") return [];
  if (!capabilityList.test(list)) throw new GitProtocolError("Invalid capability list.");
  return list.split(" ");
}

/** The name of a capability, without its `=value`. */
export const capabilityName = (capability: string) => capability.split("=", 1)[0]!;

/** Whether the client announced capability `name`, with or without a value. */
export function hasCapability(capabilities: readonly string[], name: string): boolean {
  return capabilities.some((capability) => capabilityName(capability) === name);
}

/** The value of capability `name` (`name=value`), or null. */
function capabilityValue(capabilities: readonly string[], name: string): string | null {
  const found = capabilities.find((capability) => capabilityName(capability) === name);
  return found === undefined ? null : found.slice(name.length + 1);
}

/**
 * Reads the reference update request of a receive-pack body: optional `shallow` lines, then the
 * command list (capabilities after a NUL on the first command) up to its flush-pkt, then the push
 * options when the client announced `push-options`. A `push-cert` stops parsing; the caller
 * refuses signed pushes. The pack that follows is left unread in `reader`.
 */
export async function readReceivePackRequest(reader: PktLineReader): Promise<ReceivePackRequest> {
  const commands: RefUpdateCommand[] = [];
  let capabilities: string[] = [];
  for (;;) {
    const line = await reader.next();
    if (line === FLUSH) break;
    const value = text(line, "latin1");
    if (!commands.length && value.startsWith("shallow ")) {
      if (!objectId.test(value.slice(8))) throw new GitProtocolError("Invalid shallow line.");
      continue;
    }
    if (!commands.length && value.startsWith("push-cert")) {
      const nul = value.indexOf("\0");
      return {
        commands: [],
        capabilities: nul < 0 ? [] : parseCapabilities(value.slice(nul + 1)),
        pushCert: true,
        pushOptions: [],
      };
    }
    const nul = value.indexOf("\0");
    if (nul >= 0) {
      if (commands.length) throw new GitProtocolError("Capabilities after the first command.");
      capabilities = parseCapabilities(value.slice(nul + 1));
    }
    const [oldId = "", newId = "", ref = "", ...extra] = (
      nul < 0 ? value : value.slice(0, nul)
    ).split(" ");
    if (
      extra.length ||
      !objectId.test(oldId) ||
      oldId.length !== newId.length ||
      !objectId.test(newId) ||
      !refName.test(ref)
    )
      throw new GitProtocolError("Invalid ref update command.");
    commands.push({ oldId, newId, ref });
  }
  if (!commands.length) throw new GitProtocolError("The push contains no ref update.");
  const idLength = capabilityValue(capabilities, "object-format") === "sha256" ? 64 : 40;
  if (commands.some(({ oldId }) => oldId.length !== idLength))
    throw new GitProtocolError("Object ids do not match the announced object format.");
  const pushOptions: string[] = [];
  if (hasCapability(capabilities, "push-options"))
    for (;;) {
      const line = await reader.next();
      if (line === FLUSH) break;
      pushOptions.push(text(line));
    }
  return { commands, capabilities, pushCert: false, pushOptions };
}

/** Encodes one pkt-line. */
export function pktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  if (data.length + 4 > MAX_PKT_LENGTH) throw new Error("pkt-line payload too long");
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, "0")), data]);
}

export const FLUSH_PKT = Buffer.from("0000");

/** Splits `data` into side-band packets on `band`, as receive-pack does for `side-band(-64k)`. */
function sideBand(data: Buffer, band: 1 | 2 | 3, capabilities: readonly string[]): Buffer {
  const max = hasCapability(capabilities, "side-band-64k") ? MAX_PKT_LENGTH - 5 : 995;
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += max)
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), data.subarray(offset, offset + max)])));
  return Buffer.concat(parts);
}

/** Whether the client asked for a status report, without which git cannot show a refusal. */
export const requestsStatusReport = (capabilities: readonly string[]) =>
  hasCapability(capabilities, "report-status") || hasCapability(capabilities, "report-status-v2");

export const usesSideBand = (capabilities: readonly string[]) =>
  hasCapability(capabilities, "side-band-64k") || hasCapability(capabilities, "side-band");

/**
 * A receive-pack result that refuses every ref with a reason: `unpack ok`, then one
 * `ng <ref> <reason>` per command, wrapped in side-band channel 1 when the client asked for it.
 * Git shows each as `! [remote rejected] <ref> (<reason>)`. Null when the client asked for no
 * status report, so a plain HTTP error is all it can show.
 */
export function receivePackRejection(
  capabilities: readonly string[],
  refs: readonly { ref: string; reason: string }[],
): Buffer | null {
  if (!requestsStatusReport(capabilities)) return null;
  const status = Buffer.concat([
    pktLine("unpack ok\n"),
    ...refs.map(({ ref, reason }) => pktLine(`ng ${ref} ${reason.replace(/[\r\n]+/g, " ")}\n`)),
    FLUSH_PKT,
  ]);
  return usesSideBand(capabilities)
    ? Buffer.concat([sideBand(status, 1, capabilities), FLUSH_PKT])
    : status;
}

/**
 * A ref advertisement that only carries `ERR <message>`; git stops with
 * `fatal: remote error: <message>`. Used for refusals on `info/refs`, where a status code alone
 * would leave the person with "The requested URL returned error: 403".
 */
export function advertisementError(service: string, message: string): Buffer {
  return Buffer.concat([
    pktLine(`# service=${service}\n`),
    FLUSH_PKT,
    pktLine(`ERR ${message.replace(/[\r\n]+/g, " ")}\n`),
  ]);
}

/** Status report lines kept from an upstream receive-pack result; the report itself is small. */
const MAX_STATUS_BYTES = 64 * 1024;

export interface ReceivePackResult {
  unpack: string;
  refs: { ref: string; ok: boolean; reason: string | null }[];
}

/**
 * Follows an upstream receive-pack result while it streams through: pkt-lines are split as they
 * arrive, side-band progress (bands 2 and 3) is skipped, and only the status report is kept, so a
 * long progress stream cannot push the report out of a bounded buffer. `result()` reads the
 * `unpack` line and every `ok`/`ng` ref line; null when no complete report arrived.
 */
export function createReceivePackResultReader(sideBandUsed: boolean) {
  let pending = Buffer.alloc(0);
  let status = Buffer.alloc(0);
  let broken = false;
  const keep = (data: Buffer) => {
    if (status.length + data.length > MAX_STATUS_BYTES) broken = true;
    else status = Buffer.concat([status, data]);
  };
  return {
    push(chunk: Uint8Array) {
      if (broken) return;
      if (!sideBandUsed) return keep(Buffer.from(chunk));
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const header = pending.subarray(0, 4).toString("latin1");
        if (!/^[0-9a-f]{4}$/i.test(header)) {
          broken = true;
          return;
        }
        const length = Number.parseInt(header, 16);
        if (length === 0) {
          pending = pending.subarray(4);
          continue;
        }
        if (length < 5 || length > MAX_PKT_LENGTH) {
          broken = true;
          return;
        }
        if (pending.length < length) return;
        if (pending[4] === 1) keep(pending.subarray(5, length));
        pending = pending.subarray(length);
      }
    },
    result(): ReceivePackResult | null {
      return broken ? null : parseStatusReport(status);
    },
  };
}

function parseStatusReport(status: Buffer): ReceivePackResult | null {
  const lines: (Buffer | null)[] = [];
  for (let offset = 0; offset < status.length;) {
    const header = status.subarray(offset, offset + 4).toString("latin1");
    if (!/^[0-9a-f]{4}$/i.test(header)) return null;
    const length = Number.parseInt(header, 16);
    if (length !== 0 && (length < 4 || offset + length > status.length)) return null;
    lines.push(length === 0 ? null : status.subarray(offset + 4, offset + length));
    offset += length === 0 ? 4 : length;
  }
  const [first, ...rest] = lines;
  if (!first || !text(first).startsWith("unpack ")) return null;
  const refs: ReceivePackResult["refs"] = [];
  for (const line of rest) {
    if (line === null) return { unpack: text(first).slice(7), refs };
    const [kind, ref = "", ...reason] = text(line).split(" ");
    if (kind === "ok" || kind === "ng")
      refs.push({ ref, ok: kind === "ok", reason: kind === "ng" ? reason.join(" ") : null });
    // report-status-v2 `option` lines describe the preceding ref; they do not change the outcome.
  }
  return null;
}
