import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  expectedReleaseAssetNames,
  parseCliReleaseTag,
  syncReleaseAssets,
  validateAssetPaths,
} from "../scripts/release-upload.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

async function fixtureAssets(tag = "@weldall/cli@1.2.3") {
  const root = await mkdtemp(join(tmpdir(), "weldall-release-upload-"));
  roots.push(root);
  const paths = expectedReleaseAssetNames(tag).map((name) => join(root, name));
  await Promise.all(paths.map((path, index) => writeFile(path, `asset-${index}`)));
  return paths;
}

function digest(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CLI release upload", () => {
  it("accepts only strict scoped tags and the exact expected files", async () => {
    expect(parseCliReleaseTag("@weldall/cli@1.2.3")).toBe("1.2.3");
    expect(() => parseCliReleaseTag("v1.2.3")).toThrow(/exact @weldall\/cli/);
    expect(() => parseCliReleaseTag("@weldall/cli@01.2.3")).toThrow(/exact @weldall\/cli/);
    const paths = await fixtureAssets();
    expect(validateAssetPaths(paths, "@weldall/cli@1.2.3")).toHaveLength(5);
    expect(() => validateAssetPaths(paths.slice(1), "@weldall/cli@1.2.3")).toThrow(
      /exact expected set/,
    );
  });

  it("skips identical assets and uploads only missing assets", async () => {
    const tag = "@weldall/cli@1.2.3";
    const paths = await fixtureAssets(tag);
    const names = expectedReleaseAssetNames(tag);
    const firstName = names[0];
    const firstIndex = paths.findIndex((path) => path.endsWith(firstName));
    const requests: Array<{ url: string; method: string }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/releases/tags/"))
        return jsonResponse({
          tag_name: tag,
          upload_url: "https://uploads.github.test/assets{?name,label}",
          assets: [{ name: firstName, digest: digest(`asset-${firstIndex}`) }],
        });
      return jsonResponse({ ok: true }, 201);
    };
    const result = await syncReleaseAssets({
      owner: "owner",
      repo: "repo",
      tag,
      assetPaths: paths,
      token: "token",
      fetchImpl,
      log: () => undefined,
    });
    expect(result.skipped).toEqual([firstName]);
    expect(result.uploaded.sort()).toEqual(names.filter((name) => name !== firstName).sort());
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(4);
    expect(requests[0].url).toContain(encodeURIComponent(tag));
  });

  it("downloads old assets without digest and rejects same-name mismatches", async () => {
    const tag = "@weldall/cli@1.2.3";
    const paths = await fixtureAssets(tag);
    const name = expectedReleaseAssetNames(tag)[0];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/releases/tags/"))
        return jsonResponse({
          tag_name: tag,
          upload_url: "https://uploads.github.test/assets{?name,label}",
          assets: [{ name, url: "https://api.github.test/existing" }],
        });
      return new Response("different bytes");
    };
    await expect(
      syncReleaseAssets({
        owner: "owner",
        repo: "repo",
        tag,
        assetPaths: paths,
        token: "token",
        fetchImpl,
        log: () => undefined,
      }),
    ).rejects.toThrow(/refusing to clobber/);
  });

  it("makes dry runs read-only and leaves unrelated release assets alone", async () => {
    const tag = "@weldall/cli@1.2.3";
    const paths = await fixtureAssets(tag);
    let posts = 0;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") posts += 1;
      return jsonResponse({
        tag_name: tag,
        upload_url: "https://uploads.github.test/assets{?name,label}",
        assets: [],
      });
    };
    const result = await syncReleaseAssets({
      owner: "owner",
      repo: "repo",
      tag,
      assetPaths: paths,
      token: "token",
      dryRun: true,
      fetchImpl,
      log: () => undefined,
    });
    expect(result.uploaded).toEqual([]);
    expect(posts).toBe(0);

    await expect(
      syncReleaseAssets({
        owner: "owner",
        repo: "repo",
        tag,
        assetPaths: paths,
        token: "token",
        dryRun: true,
        fetchImpl: async () =>
          jsonResponse({
            tag_name: tag,
            upload_url: "https://upload",
            assets: [{ name: "unrelated-release-notes.pdf", state: "uploaded", size: 123 }],
          }),
        log: () => undefined,
      }),
    ).resolves.toMatchObject({ uploaded: [], skipped: [], recovered: [] });
  });

  it("deletes only a failed zero-byte starter asset in upload mode, then retries it", async () => {
    const tag = "@weldall/cli@1.2.3";
    const paths = await fixtureAssets(tag);
    const failedName = expectedReleaseAssetNames(tag)[0];
    const requests: Array<{ url: string; method: string }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url.includes("/releases/tags/"))
        return jsonResponse({
          tag_name: tag,
          upload_url: "https://uploads.github.test/assets{?name,label}",
          assets: [
            {
              id: 42,
              name: failedName,
              state: "starter",
              size: 0,
              url: "https://api.github.test/assets/42",
            },
            { name: "unrelated.txt", state: "uploaded", size: 5 },
          ],
        });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse({ ok: true }, 201);
    };

    const result = await syncReleaseAssets({
      owner: "owner",
      repo: "repo",
      tag,
      assetPaths: paths,
      token: "token",
      fetchImpl,
      log: () => undefined,
    });
    expect(result.recovered).toEqual([failedName]);
    expect(result.uploaded).toContain(failedName);
    expect(requests.filter(({ method }) => method === "DELETE")).toEqual([
      { url: "https://api.github.test/assets/42", method: "DELETE" },
    ]);
    expect(requests.findIndex(({ method }) => method === "DELETE")).toBeLessThan(
      requests.findIndex(
        ({ url, method }) => method === "POST" && url.includes(encodeURIComponent(failedName)),
      ),
    );
  });

  it("only reports failed starter cleanup in dry-run mode", async () => {
    const tag = "@weldall/cli@1.2.3";
    const paths = await fixtureAssets(tag);
    const failedName = expectedReleaseAssetNames(tag)[0];
    const methods: string[] = [];
    const logs: string[] = [];
    const result = await syncReleaseAssets({
      owner: "owner",
      repo: "repo",
      tag,
      assetPaths: paths,
      token: "token",
      dryRun: true,
      fetchImpl: async (input, init) => {
        methods.push(init?.method ?? "GET");
        return jsonResponse({
          tag_name: tag,
          upload_url: "https://uploads.github.test/assets{?name,label}",
          assets: [
            {
              name: failedName,
              state: "starter",
              size: 0,
              url: "https://api.github.test/assets/42",
            },
          ],
        });
      },
      log: (message) => logs.push(message),
    });
    expect(result).toMatchObject({ uploaded: [], skipped: [], recovered: [], dryRun: true });
    expect(methods).toEqual(["GET"]);
    expect(logs.join("\n")).toMatch(/would delete failed zero-byte starter asset/);
  });

  it("never deletes completed or nonzero mismatched expected assets", async () => {
    const tag = "@weldall/cli@1.2.3";
    const paths = await fixtureAssets(tag);
    const name = expectedReleaseAssetNames(tag)[0];
    for (const asset of [
      { name, state: "uploaded", size: 0, digest: digest("different") },
      { name, state: "starter", size: 4, digest: digest("different") },
    ]) {
      const methods: string[] = [];
      await expect(
        syncReleaseAssets({
          owner: "owner",
          repo: "repo",
          tag,
          assetPaths: paths,
          token: "token",
          fetchImpl: async (_input, init) => {
            methods.push(init?.method ?? "GET");
            return jsonResponse({
              tag_name: tag,
              upload_url: "https://uploads.github.test/assets{?name,label}",
              assets: [asset],
            });
          },
          log: () => undefined,
        }),
      ).rejects.toThrow(/refusing to clobber/);
      expect(methods).toEqual(["GET"]);
    }
  });
});
