import { describe, expect, it } from "vitest";
import { parseGitProxyRequest, parseGitRemotePath } from "../src/server/git-proxy/paths";
import {
  advertisementError,
  GitProtocolError,
  createReceivePackResultReader,
  pktLine,
  PktLineReader,
  readReceivePackRequest,
  receivePackRejection,
} from "../src/server/git-proxy/pkt-line";
import {
  checkPushRules,
  GIT_MAX_REF_UPDATES,
  GIT_PUBLISH_BRANCH_PREFIX,
  GIT_PUSH_REASONS,
  pullRequestRejection,
} from "../src/server/git-proxy/rules";

const zero = "0".repeat(40);
const a = "a".repeat(40);
const b = "b".repeat(40);
const branch = `refs/heads/${GIT_PUBLISH_BRANCH_PREFIX}change-1`;
const caps = "report-status side-band-64k agent=git/2.39.3";
const flush = Buffer.from("0000");

/** A stream that delivers `data` in chunks of `size` bytes. */
function streamOf(data: Buffer, size = data.length) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) return controller.close();
      controller.enqueue(new Uint8Array(data.subarray(offset, offset + size)));
      offset += size;
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
    chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const commandList = (...lines: string[]) =>
  Buffer.concat([...lines.map((line) => pktLine(line)), flush]);

async function parse(data: Buffer, { chunk = data.length, max = 64 * 1024 } = {}) {
  const reader = new PktLineReader(streamOf(data, chunk).getReader(), max);
  const request = await readReceivePackRequest(reader);
  return { request, replayed: await collect(reader.replay()) };
}

describe("receive-pack command list", () => {
  it("reads commands and capabilities and replays every byte, also split into 1-byte chunks", async () => {
    const pack = Buffer.from("PACK\u0000\u0000\u0000\u0002rest-of-pack");
    const body = Buffer.concat([
      commandList(`${zero} ${a} ${branch}\0${caps}\n`, `${a} ${b} refs/heads/other\n`),
      pack,
    ]);
    for (const chunk of [1, 3, 7, body.length]) {
      const { request, replayed } = await parse(body, { chunk });
      expect(request).toEqual({
        commands: [
          { oldId: zero, newId: a, ref: branch },
          { oldId: a, newId: b, ref: "refs/heads/other" },
        ],
        capabilities: ["report-status", "side-band-64k", "agent=git/2.39.3"],
        pushCert: false,
        pushOptions: [],
      });
      expect(replayed.equals(body)).toBe(true);
    }
  });

  it("accepts SHA-256 object ids only when the object format says so", async () => {
    const id = "c".repeat(64);
    const { request } = await parse(
      commandList(`${"0".repeat(64)} ${id} ${branch}\0report-status object-format=sha256`),
    );
    expect(request.commands[0]).toEqual({ oldId: "0".repeat(64), newId: id, ref: branch });
    await expect(
      parse(commandList(`${"0".repeat(64)} ${id} ${branch}\0report-status`)),
    ).rejects.toBeInstanceOf(GitProtocolError);
  });

  it("skips shallow lines, reads push options and stops at a push certificate", async () => {
    const { request, replayed } = await parse(
      Buffer.concat([
        pktLine(`shallow ${b}\n`),
        commandList(`${a} ${b} ${branch}\0report-status push-options\n`),
        commandList("ci.skip\n", "merge_request.create\n"),
        Buffer.from("PACK"),
      ]),
    );
    expect(request.pushOptions).toEqual(["ci.skip", "merge_request.create"]);
    expect(replayed.subarray(-4).toString()).toBe("PACK");
    const signed = await parse(
      commandList(`push-cert\0report-status side-band-64k\n`, "certificate version 0.1\n"),
    );
    expect(signed.request).toMatchObject({ pushCert: true, commands: [] });
    expect(signed.request.capabilities).toContain("side-band-64k");
  });

  it.each([
    ["no commands", flush],
    ["a bad length", Buffer.from("zzzz")],
    ["a delimiter packet", Buffer.from("0001")],
    ["a truncated line", Buffer.from("0040abc")],
    ["an end before the flush", pktLine(`${zero} ${a} ${branch}\0report-status\n`)],
    ["a short object id", commandList(`${zero.slice(1)} ${a} ${branch}\0report-status`)],
    ["mixed id lengths", commandList(`${zero} ${"a".repeat(64)} ${branch}\0report-status`)],
    ["an extra field", commandList(`${zero} ${a} ${branch} extra\0report-status`)],
    ["a missing ref", commandList(`${zero} ${a}\0report-status`)],
    [
      "capabilities on a later command",
      commandList(`${zero} ${a} ${branch}\0report-status`, `${zero} ${a} refs/heads/x\0agent`),
    ],
  ])("refuses %s", async (_name, body) => {
    await expect(parse(body)).rejects.toMatchObject({ code: "malformed" });
  });

  it("reads capabilities the way git does, so none can hide", async () => {
    // Git 2.39 puts one space after the NUL.
    const real = await parse(
      commandList(
        `${zero} ${a} ${branch}\0 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.39.3.(Apple.Git-145)\n`,
      ),
    );
    expect(real.request.capabilities).toContain("report-status-v2");
    // `push-options=1` still announces push options; their packets are not taken for the pack.
    const valued = await parse(
      Buffer.concat([
        commandList(`${zero} ${a} ${branch}\0report-status push-options=1\n`),
        commandList("evil.option=1\n"),
        Buffer.from("PACK"),
      ]),
    );
    expect(valued.request.pushOptions).toEqual(["evil.option=1"]);
    for (const list of [
      "report-status\tpush-options",
      "report-status  push-options",
      "report-status ",
      "report-status\u00a0x",
    ])
      await expect(parse(commandList(`${zero} ${a} ${branch}\0${list}\n`))).rejects.toMatchObject({
        code: "malformed",
      });
  });

  it("keeps the ref name byte for byte", async () => {
    const { request } = await parse(commandList(`${zero} ${a} ${branch}\u00a0\0report-status\n`));
    expect(request.commands[0]!.ref).not.toBe(branch);
    expect(request.commands[0]!.ref.startsWith(branch)).toBe(true);
    expect(checkPushRules(request, "main")).toEqual([
      { ref: request.commands[0]!.ref, reason: GIT_PUSH_REASONS.invalidBranch },
    ]);
  });

  it("stops at the command list size cap without reading further", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `${zero} ${a} ${branch}-${i}`);
    lines[0] += "\0report-status";
    await expect(parse(commandList(...lines), { max: 1024 })).rejects.toMatchObject({
      code: "too_large",
    });
  });
});

describe("push rules", () => {
  const request = (...commands: [string, string, string][]) => ({
    commands: commands.map(([oldId, newId, ref]) => ({ oldId, newId, ref })),
    capabilities: ["report-status"],
    pushCert: false,
    pushOptions: [] as string[],
  });

  it("allows creating and updating publish branches", () => {
    expect(checkPushRules(request([zero, a, branch]), "main")).toBeNull();
    expect(checkPushRules(request([a, b, branch]), "main")).toBeNull();
  });

  it.each([
    ["the default branch", "refs/heads/main", GIT_PUSH_REASONS.defaultBranch],
    ["the default branch in other case", "refs/heads/MAIN", GIT_PUSH_REASONS.defaultBranch],
    ["another branch", "refs/heads/feature", GIT_PUSH_REASONS.onlyPublishBranches],
    [
      "the bare prefix",
      `refs/heads/${GIT_PUBLISH_BRANCH_PREFIX}`,
      GIT_PUSH_REASONS.onlyPublishBranches,
    ],
    ["a tag", "refs/tags/v1", GIT_PUSH_REASONS.tag],
    ["a note", "refs/notes/commits", GIT_PUSH_REASONS.onlyPublishBranches],
    ["a pull ref", "refs/pull/1/head", GIT_PUSH_REASONS.onlyPublishBranches],
    ["a dotted branch", `${branch}/../x`, GIT_PUSH_REASONS.invalidBranch],
    ["a lock name", `${branch}.lock`, GIT_PUSH_REASONS.invalidBranch],
  ])("refuses %s", (_name, ref, reason) => {
    expect(checkPushRules(request([a, b, ref]), "main")).toEqual([{ ref, reason }]);
  });

  it("refuses deletions, also of the default branch", () => {
    expect(checkPushRules(request([a, zero, branch]), "main")).toEqual([
      { ref: branch, reason: GIT_PUSH_REASONS.deletion },
    ]);
    expect(checkPushRules(request([a, zero, "refs/heads/main"]), "main")).toEqual([
      { ref: "refs/heads/main", reason: GIT_PUSH_REASONS.defaultBranch },
    ]);
  });

  it("refuses the whole push when one ref is refused", () => {
    expect(checkPushRules(request([zero, a, branch], [a, b, "refs/heads/main"]), "main")).toEqual([
      { ref: branch, reason: GIT_PUSH_REASONS.otherRefRejected },
      { ref: "refs/heads/main", reason: GIT_PUSH_REASONS.defaultBranch },
    ]);
  });

  it("refuses push options, signed pushes, duplicates and too many refs", () => {
    expect(
      checkPushRules({ ...request([zero, a, branch]), pushOptions: ["ci.skip"] }, "main"),
    ).toEqual([{ ref: branch, reason: GIT_PUSH_REASONS.pushOptions }]);
    expect(checkPushRules({ ...request(), pushCert: true }, "main")).toEqual([
      { ref: "(signed push)", reason: GIT_PUSH_REASONS.signedPush },
    ]);
    expect(checkPushRules(request([zero, a, branch], [zero, b, branch]), "main")?.[0]?.reason).toBe(
      GIT_PUSH_REASONS.duplicateRef,
    );
    const many = Array.from(
      { length: GIT_MAX_REF_UPDATES + 1 },
      (_, i) => [zero, a, `${branch}-${i}`] as [string, string, string],
    );
    expect(checkPushRules(request(...many), "main")?.[0]?.reason).toBe(
      GIT_PUSH_REASONS.tooManyRefs,
    );
  });

  it("allows only known capabilities and requires a status report", () => {
    const withCaps = (...capabilities: string[]) => ({
      ...request([zero, a, branch]),
      capabilities,
    });
    expect(
      checkPushRules(
        withCaps(
          "report-status-v2",
          "side-band-64k",
          "quiet",
          "atomic",
          "agent=git/2.54.0",
          "object-format=sha1",
          "session-id=abc",
        ),
        "main",
      ),
    ).toBeNull();
    expect(checkPushRules(withCaps("quiet"), "main")?.[0]?.reason).toBe(
      GIT_PUSH_REASONS.noStatusReport,
    );
    expect(checkPushRules(withCaps("report-status", "push-options=1"), "main")?.[0]?.reason).toBe(
      GIT_PUSH_REASONS.pushOptions,
    );
    expect(checkPushRules(withCaps("report-status", "no-thin"), "main")?.[0]?.reason).toBe(
      "weldall: unsupported push capability no-thin",
    );
  });

  it.each([
    "refs/heads/weldall/publish-a b",
    "refs/heads/weldall/publish-a\u00a0",
    "refs/heads/weldall/publish-ä",
    "refs/heads/weldall/publish-a~1",
    "refs/heads/weldall/publish-a@{1}",
    "refs/heads/weldall/publish-a\\b",
    "refs/heads/weldall/publish-a:b",
    "refs/heads/weldall/publish-a/",
  ])("refuses the ref name %j", (ref) => {
    expect(checkPushRules(request([zero, a, ref]), "main")?.[0]?.reason).toBe(
      GIT_PUSH_REASONS.invalidBranch,
    );
  });

  it("refuses branches whose pull request is closed or merged", () => {
    expect(pullRequestRejection(null)).toBeNull();
    expect(pullRequestRejection("open")).toBeNull();
    expect(pullRequestRejection("merged")).toBe(GIT_PUSH_REASONS.pullRequestClosed);
    expect(pullRequestRejection("closed")).toBe(GIT_PUSH_REASONS.pullRequestClosed);
  });
});

/** Feeds an upstream receive-pack result in `size`-byte chunks, as it streams through the proxy. */
function parseReceivePackResult(data: Buffer, sideBand: boolean, size = 3) {
  const reader = createReceivePackResultReader(sideBand);
  for (let offset = 0; offset < data.length; offset += size)
    reader.push(data.subarray(offset, offset + size));
  return reader.result();
}

describe("protocol replies", () => {
  it("writes a side-band report-status git reads back as rejected refs", () => {
    const refs = [{ ref: branch, reason: "weldall: no" }];
    const banded = receivePackRejection(["report-status", "side-band-64k"], refs)!;
    expect(parseReceivePackResult(banded, true)).toEqual({
      unpack: "ok",
      refs: [{ ref: branch, ok: false, reason: "weldall: no" }],
    });
    const plain = receivePackRejection(["report-status"], refs)!;
    expect(plain.toString()).toBe(
      `000eunpack ok\n${(branch.length + 4 + 16).toString(16).padStart(4, "0")}ng ${branch} weldall: no\n0000`,
    );
    expect(receivePackRejection(["side-band-64k"], refs)).toBeNull();
  });

  it("reads an upstream result with progress on band 2 and reports cut-off results as unknown", () => {
    const status = Buffer.concat([pktLine("unpack ok\n"), pktLine(`ok ${branch}\n`), flush]);
    const result = Buffer.concat([
      pktLine(Buffer.concat([Buffer.from([2]), Buffer.from("Resolving deltas\n")])),
      pktLine(Buffer.concat([Buffer.from([1]), status])),
      flush,
    ]);
    expect(parseReceivePackResult(result, true)).toEqual({
      unpack: "ok",
      refs: [{ ref: branch, ok: true, reason: null }],
    });
    expect(parseReceivePackResult(result.subarray(0, 30), true)).toBeNull();
    // Long progress output does not push the status report out of the bounded buffer.
    const progress = pktLine(Buffer.concat([Buffer.from([2]), Buffer.alloc(60_000, "p")]));
    const noisy = Buffer.concat([...Array.from({ length: 5 }, () => progress), result]);
    expect(parseReceivePackResult(noisy, true, 4096)?.refs).toEqual([
      { ref: branch, ok: true, reason: null },
    ]);
    expect(
      parseReceivePackResult(
        Buffer.concat([
          pktLine("unpack index-pack failed\n"),
          pktLine(`ng ${branch} unpacker error\n`),
          flush,
        ]),
        false,
      ),
    ).toEqual({
      unpack: "index-pack failed",
      refs: [{ ref: branch, ok: false, reason: "unpacker error" }],
    });
  });

  it("puts a refusal into the ref advertisement as ERR", () => {
    expect(advertisementError("git-upload-pack", "weldall: no").toString()).toBe(
      "001e# service=git-upload-pack\n0000" + "0014ERR weldall: no\n",
    );
  });
});

describe("proxy paths", () => {
  const url = (path: string) => new URL(`https://weldall.example.com${path}`);

  it("accepts exactly the three smart-HTTP endpoints", () => {
    const repository = { connectorKey: "github", owner: "Acme", name: "app.one" };
    expect(
      parseGitProxyRequest(
        "GET",
        url("/git/github/Acme/app.one.git/info/refs?service=git-upload-pack"),
      ),
    ).toEqual({ repository, endpoint: { kind: "advertisement", service: "git-upload-pack" } });
    expect(
      parseGitProxyRequest("POST", url("/git/github/Acme/app.one.git/git-receive-pack")),
    ).toEqual({ repository, endpoint: { kind: "rpc", service: "git-receive-pack" } });
  });

  it.each([
    ["GET", "/git/github/acme/app.git/info/refs"],
    ["GET", "/git/github/acme/app.git/info/refs?service=git-upload-archive"],
    ["GET", "/git/github/acme/app.git/HEAD"],
    ["GET", "/git/github/acme/app.git/objects/info/packs"],
    ["POST", "/git/github/acme/app.git/info/refs?service=git-upload-pack"],
    ["GET", "/git/github/acme/app.git/git-upload-pack"],
    ["POST", "/git/github/acme/app/git-upload-pack"],
    ["POST", "/git/github/acme%2Fother/app.git/git-upload-pack"],
    ["POST", "/git/github/acme/app%2egit/git-upload-pack"],
    ["POST", "/git/github//app.git/git-upload-pack"],
    ["POST", "/git/github/acme/x/app.git/git-upload-pack"],
    ["POST", "/git/github/acme/app.git/git-upload-pack/"],
    ["POST", "/git/github/acme/..git/git-upload-pack"],
    ["POST", "/other/github/acme/app.git/git-upload-pack"],
  ])("refuses %s %s", (method, path) => {
    expect(parseGitProxyRequest(method, url(path))).toBeNull();
  });

  it("normalises dot segments before matching, so they cannot reach another endpoint shape", () => {
    expect(
      parseGitProxyRequest("POST", url("/git/github/acme/app.git/../../x/y.git/git-upload-pack")),
    ).toEqual({
      repository: { connectorKey: "github", owner: "x", name: "y" },
      endpoint: { kind: "rpc", service: "git-upload-pack" },
    });
  });

  it("parses the repository path the credential helper sends", () => {
    const expected = { connectorKey: "github", owner: "acme", name: "app" };
    expect(parseGitRemotePath("git/github/acme/app.git")).toEqual(expected);
    expect(parseGitRemotePath("/git/github/acme/app.git")).toEqual(expected);
    for (const path of [
      "git/github/acme/app",
      "git/github/acme/app.git/info/refs",
      "git/x/../a.git",
    ])
      expect(parseGitRemotePath(path)).toBeNull();
  });
});
