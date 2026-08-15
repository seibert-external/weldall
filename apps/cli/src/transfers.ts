import { randomUUID } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CliError } from "./errors.js";

export type RequestPayload =
  | { kind: "none" }
  | { kind: "text"; body: string }
  | { kind: "json"; value: unknown }
  | { kind: "file"; body: Blob }
  | { kind: "form"; body: FormData };

type FormPart =
  | { name: string; kind: "field"; value: string }
  | { name: string; kind: "file"; path: string; contentType: string };

const parseFormPart = (value: string): FormPart => {
  const separator = value.indexOf("=");
  const name = value.slice(0, separator);
  const partValue = value.slice(separator + 1);
  if (separator < 1) throw new CliError(`Invalid form part ${JSON.stringify(value)}`);
  if (!partValue.startsWith("@")) return { name, kind: "field", value: partValue };

  const typeMarker = partValue.lastIndexOf(";type=");
  const path = partValue.slice(1, typeMarker < 0 ? undefined : typeMarker);
  const contentType = typeMarker < 0 ? "application/octet-stream" : partValue.slice(typeMarker + 6);
  if (!path || !contentType || /[\r\n]/.test(contentType) || !contentType.includes("/")) {
    throw new CliError(`Invalid file form part ${JSON.stringify(value)}`);
  }
  return { name, kind: "file", path, contentType };
};

const fileBlob = async (path: string, contentType: string) => {
  try {
    const bun = (
      globalThis as typeof globalThis & {
        Bun?: {
          file(path: string, options: { type: string }): Blob & { exists(): Promise<boolean> };
        };
      }
    ).Bun;
    if (bun) {
      const file = bun.file(path, { type: contentType });
      if (!(await file.exists())) throw new Error("Upload file does not exist");
      return file;
    }
    return await openAsBlob(path, { type: contentType });
  } catch (error) {
    throw new CliError(`Cannot open upload file ${JSON.stringify(path)}`, { cause: error });
  }
};

export async function buildRequestPayload(input: {
  method: string;
  data?: string | undefined;
  json?: unknown;
  uploadFile?: string | undefined;
  form?: string[] | undefined;
}): Promise<RequestPayload> {
  const modes = [
    input.data !== undefined,
    input.json !== undefined,
    input.uploadFile !== undefined,
    input.form !== undefined,
  ].filter(Boolean).length;
  if (modes > 1) {
    throw new CliError("Use only one of --data, --json, --upload-file, or --form");
  }
  if (["GET", "HEAD"].includes(input.method) && modes > 0) {
    throw new CliError(`${input.method} requests cannot have a body`);
  }
  if (input.data !== undefined) return { kind: "text", body: input.data };
  if (input.json !== undefined) return { kind: "json", value: input.json };
  if (input.uploadFile !== undefined) {
    return {
      kind: "file",
      body: await fileBlob(input.uploadFile, "application/octet-stream"),
    };
  }
  if (input.form !== undefined) {
    const body = new FormData();
    for (const value of input.form) {
      const part = parseFormPart(value);
      if (part.kind === "field") body.append(part.name, part.value);
      else body.append(part.name, await fileBlob(part.path, part.contentType), basename(part.path));
    }
    return { kind: "form", body };
  }
  return { kind: "none" };
}

export const isTextResponse = (response: Response) => {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    contentType === undefined ||
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType.endsWith("+json") ||
    contentType === "application/xml" ||
    contentType.endsWith("+xml") ||
    contentType === "application/javascript" ||
    contentType === "application/x-www-form-urlencoded"
  );
};

export async function writeResponseBody(response: Response, destination: string) {
  const source =
    response.body === null
      ? Readable.from([])
      : Readable.fromWeb(
          response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
        );
  if (destination === "-") {
    await pipeline(source, process.stdout, { end: false });
    return;
  }

  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const abort = new AbortController();
  let interruptedSignal: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
    if (interruptedSignal) return;
    interruptedSignal = signal;
    const error = new Error(`Download interrupted by ${signal}`);
    abort.abort(error);
    source.destroy(error);
    output.destroy(error);
  };
  const signalHandlers = (["SIGINT", "SIGTERM"] as const).map(
    (signal) => [signal, () => interrupt(signal)] as const,
  );
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  };
  const terminateFromSignal = async () => {
    if (!interruptedSignal) return;
    const signal = interruptedSignal;
    removeSignalHandlers();
    process.kill(process.pid, signal);
    await new Promise<never>(() => undefined);
  };

  try {
    await pipeline(source, output, { signal: abort.signal });
    if (interruptedSignal) throw abort.signal.reason;
    await rename(temporary, destination);
    await terminateFromSignal();
  } catch (error) {
    let cleanupError: unknown;
    try {
      await rm(temporary, { force: true });
    } catch (caught) {
      cleanupError = caught;
    }
    await terminateFromSignal();
    const cause = cleanupError
      ? new AggregateError([error, cleanupError], "Download and temporary-file cleanup failed")
      : error;
    throw new CliError(`Cannot write response to ${JSON.stringify(destination)}`, { cause });
  } finally {
    removeSignalHandlers();
  }
}
