import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRequestPayload, writeResponseBody } from "../src/transfers.js";

const directories: string[] = [];
const temporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "weldall-transfer-test-"));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("request payloads", () => {
  it("opens raw uploads without decoding binary data", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "payload.bin");
    const bytes = Uint8Array.from([0, 255, 128, 13, 10]);
    await writeFile(path, bytes);

    const payload = await buildRequestPayload({ method: "PUT", uploadFile: path });

    expect(payload.kind).toBe("file");
    if (payload.kind !== "file") throw new Error("expected file payload");
    expect(new Uint8Array(await payload.body.arrayBuffer())).toEqual(bytes);
  });

  it("builds multipart fields and file parts with names and media types", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "report.pdf");
    const bytes = Uint8Array.from([37, 80, 68, 70, 0, 255]);
    await writeFile(path, bytes);

    const payload = await buildRequestPayload({
      method: "POST",
      form: ["title=Quarterly report", `document=@${path};type=application/pdf`],
    });

    expect(payload.kind).toBe("form");
    if (payload.kind !== "form") throw new Error("expected multipart payload");
    expect(payload.body.get("title")).toBe("Quarterly report");
    const file = payload.body.get("document");
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) throw new Error("expected file form part");
    expect(file.name).toBe("report.pdf");
    expect(file.type).toBe("application/pdf");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    const request = new Request("https://files.example/upload", {
      method: "POST",
      body: payload.body,
    });
    expect(request.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
  });

  it("rejects ambiguous body modes and bodies on GET requests", async () => {
    await expect(
      buildRequestPayload({ method: "POST", data: "text", form: ["field=value"] }),
    ).rejects.toThrow("Use only one");
    await expect(buildRequestPayload({ method: "GET", uploadFile: "file" })).rejects.toThrow(
      "GET requests cannot have a body",
    );
  });
});

describe("response downloads", () => {
  it("writes response bytes exactly and replaces the destination atomically", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "download.bin");
    const bytes = Uint8Array.from([0, 255, 128, 13, 10]);
    await writeFile(destination, "old contents");

    await writeResponseBody(new Response(bytes), destination);

    expect(new Uint8Array(await readFile(destination))).toEqual(bytes);
    expect(await readdir(directory)).toEqual(["download.bin"]);
  });

  it("preserves an existing destination when response streaming fails", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "download.bin");
    await writeFile(destination, "old contents");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
        controller.error(new Error("connection lost"));
      },
    });

    await expect(writeResponseBody(new Response(body), destination)).rejects.toThrow(
      "Cannot write response",
    );

    expect(await readFile(destination, "utf8")).toBe("old contents");
    expect(await readdir(directory)).toEqual(["download.bin"]);
  });
});
