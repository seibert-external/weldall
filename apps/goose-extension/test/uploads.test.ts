import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACHED_LIST_ENV, MAX_UPLOAD_BYTES, callTool, tools } from "../src/tools.js";
import { REQUEST_TIMEOUT } from "../src/cli.js";

const url = "https://weldall.example.com/api/contracts/c1/attachments";
let dir: string;
let attached: string;
let list: string;

const attach = (...files: string[]) => fs.writeFileSync(list, files.join("\n") + "\n");
const send = (body: Record<string, unknown>, cli = { run: vi.fn().mockResolvedValue("{}") }) =>
  callTool(cli, "send", { url, method: "POST", scope: "contracts:write", ...body }).then(
    (result) => ({ result, cli }),
  );
const refused = async (body: Record<string, unknown>, code: string) => {
  const { result, cli } = await send(body);
  expect(result.structuredContent).toMatchObject({ error: { code } });
  expect(cli.run).not.toHaveBeenCalled();
};

beforeEach(() => {
  // Resolve the temp folder itself: on macOS it is reached through the /var link.
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "weldall-upload-")));
  attached = path.join(dir, "signed;type=text-html.pdf");
  fs.writeFileSync(attached, "%PDF-1.7");
  list = path.join(dir, "attached.txt");
  attach(attached);
  vi.stubEnv(ATTACHED_LIST_ENV, list);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("uploads of attached files", () => {
  it("sends an attached file as the raw body with its resolved path", async () => {
    const link = path.join(dir, "link.pdf");
    fs.symlinkSync(attached, link);
    const { result, cli } = await send({
      file: link,
      headers: ["Content-Type: application/pdf"],
    });
    expect(result.isError).not.toBe(true);
    expect(cli.run).toHaveBeenCalledExactlyOnceWith(
      [
        "request",
        "--method=POST",
        "--scope=contracts:write",
        "--header=Content-Type: application/pdf",
        `--upload-file=${attached}`,
        url,
      ],
      undefined,
      REQUEST_TIMEOUT,
    );
  });

  it("maps form parts, always naming the file type and joining values to the option", async () => {
    const { result, cli } = await send({
      form: [
        { name: "comment", value: "--signed copy" },
        { name: "file", file: attached },
        { name: "copy", file: attached, type: "application/pdf" },
      ],
    });
    expect(result.isError).not.toBe(true);
    expect(cli.run.mock.calls[0]?.[0]).toEqual([
      "request",
      "--method=POST",
      "--scope=contracts:write",
      "--form=comment=--signed copy",
      `--form=file=@${attached};type=application/octet-stream`,
      `--form=copy=@${attached};type=application/pdf`,
      url,
    ]);
  });

  it("reads the attached list again on every call", async () => {
    attach();
    await refused({ file: attached }, "upload_not_attached");
    attach(attached);
    const { result } = await send({ file: attached });
    expect(result.isError).not.toBe(true);
  });

  it("reads a Windows-written list", async () => {
    fs.writeFileSync(list, `\uFEFF${attached}\r\n\r\nrelative.pdf\r\n`);
    const { result, cli } = await send({ file: attached });
    expect(result.isError).not.toBe(true);
    expect(cli.run.mock.calls[0]?.[0]).toContain(`--upload-file=${attached}`);
  });

  it("compares list entries as written, so a listed copy turned into a link does not match", async () => {
    const secret = path.join(dir, "id_ed25519");
    fs.writeFileSync(secret, "secret");
    const copy = path.join(dir, "copy.pdf");
    fs.symlinkSync(secret, copy);
    attach(copy);
    await refused({ file: copy }, "upload_not_attached");
    await refused({ file: secret }, "upload_not_attached");
  });

  it("refuses uploads when the host names no attached list", async () => {
    vi.stubEnv(ATTACHED_LIST_ENV, "");
    await refused({ file: attached }, "upload_unavailable");
    await refused({ form: [{ name: "file", file: attached }] }, "upload_unavailable");
  });

  it("refuses when the attached list is missing", async () => {
    fs.rmSync(list);
    await refused({ file: attached }, "upload_not_attached");
  });

  it("refuses a file that is not on the attached list, in file and in form", async () => {
    const other = path.join(dir, "other.pdf");
    fs.writeFileSync(other, "secret");
    await refused({ file: other }, "upload_not_attached");
    await refused(
      {
        form: [
          { name: "a", file: attached },
          { name: "b", file: other },
        ],
      },
      "upload_not_attached",
    );
  });

  it("refuses a link that points to an unlisted file", async () => {
    const other = path.join(dir, "other.pdf");
    fs.writeFileSync(other, "secret");
    const link = path.join(dir, "innocent.pdf");
    fs.symlinkSync(other, link);
    await refused({ file: link }, "upload_not_attached");
  });

  it("refuses a missing file", async () => {
    await refused({ file: path.join(dir, "gone.pdf") }, "upload_not_attached");
  });

  it("refuses a listed directory", async () => {
    attach(dir);
    await refused({ file: dir }, "upload_not_file");
  });

  it("refuses a listed file larger than 100 MB", async () => {
    const large = path.join(dir, "large.bin");
    fs.writeFileSync(large, "");
    fs.truncateSync(large, MAX_UPLOAD_BYTES + 1); // sparse, no disk use
    attach(large);
    await refused({ file: large }, "upload_too_large");
  });

  it.each([
    { label: "a relative path", body: { file: "signed.pdf" } },
    {
      label: "a text value starting with @",
      body: { form: [{ name: "f", value: "@/etc/passwd" }] },
    },
    { label: "= in a part name", body: { form: [{ name: "a=b", value: "x" }] } },
    {
      label: "a part with value and file",
      body: { form: [{ name: "f", value: "x", file: "/x" }] },
    },
    { label: "an invalid type", body: { form: [{ name: "f", file: "/x", type: "pdf" }] } },
    { label: "an empty form", body: { form: [] } },
    {
      label: "form with a Content-Type header",
      body: { form: [{ name: "f", value: "x" }], headers: ["Content-Type: multipart/form-data"] },
    },
    { label: "file and form", body: { file: "/x", form: [{ name: "f", value: "x" }] } },
    { label: "file and json", body: { file: "/x", json: {} } },
    { label: "form and text", body: { form: [{ name: "f", value: "x" }], text: "x" } },
  ])("refuses $label before the CLI runs", async ({ body }) => {
    await refused(body, "invalid_request");
  });

  it("refuses an upload before the connection preflight runs", async () => {
    vi.stubEnv(ATTACHED_LIST_ENV, "");
    const cli = { run: vi.fn() };
    const result = await callTool(cli, "send", {
      url,
      method: "POST",
      connection: "work",
      requiredScopes: ["files:write"],
      file: attached,
    });
    expect(result.structuredContent).toMatchObject({ error: { code: "upload_unavailable" } });
    expect(cli.run).not.toHaveBeenCalled();
  });

  it("advertises file and form with the argument names the client's approval card reads", () => {
    const schema = tools.find((tool) => tool.name === "send")!.inputSchema;
    expect(schema.properties?.file).toMatchObject({ type: "string" });
    expect(schema.properties?.form).toMatchObject({ type: "array", minItems: 1 });
    expect(JSON.stringify(schema.properties?.form)).toContain('"file"');
  });
});
