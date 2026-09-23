import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkImageProblems,
  compareVersions,
  fetchPublishedVersions,
  imageReleaseUnits,
  imageReleaseUnitsByImage,
  parseImageReleaseTag,
  planImageTags,
} from "../../../scripts/image-release.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const workflow = readFileSync(
  new URL(".github/workflows/release-docker-images.yml", repoRoot),
  "utf8",
);

describe("image release tags", () => {
  it("maps each release unit to its image, build context and Dockerfile", () => {
    expect(parseImageReleaseTag("@weldall/weldall@1.2.3")).toMatchObject({
      packageName: "@weldall/weldall",
      image: "weldall",
      version: "1.2.3",
      context: ".",
      dockerfile: "Dockerfile",
    });
    expect(parseImageReleaseTag("@weldall/discovery-proxy@0.1.0")).toMatchObject({
      packageName: "@weldall/discovery-proxy",
      image: "discovery-proxy",
      version: "0.1.0",
      context: "apps/discovery-proxy",
      dockerfile: "apps/discovery-proxy/Dockerfile",
    });
  });

  it("names the package of each unit after its directory's package.json", () => {
    for (const [packageName, unit] of Object.entries(imageReleaseUnits)) {
      const packageJson = JSON.parse(
        readFileSync(new URL(`${unit.directory}/package.json`, repoRoot), "utf8"),
      );
      expect(packageJson.name).toBe(packageName);
      expect(packageJson.private).toBe(true);
    }
  });

  it.each([
    "@weldall/cli@1.0.0",
    "@weldall/sdk@1.0.0",
    "@weldall/weldall@1.0",
    "@weldall/weldall@1.0.0-rc.1",
    "@weldall/weldall@v1.0.0",
    "weldall@1.0.0",
    "",
  ])("rejects %j", (tag) => {
    expect(() => parseImageReleaseTag(tag)).toThrow(/Expected an exact/);
  });
});

describe("floating tag plan", () => {
  it("writes every tag for the first or highest release", () => {
    expect(planImageTags("0.1.0", [])).toEqual(["0.1.0", "0.1", "latest"]);
    expect(planImageTags("1.0.0", ["0.9.9", "0.9.10"])).toEqual(["1.0.0", "1.0", "latest"]);
    expect(planImageTags("1.2.3", ["1.2.3"])).toEqual(["1.2.3", "1.2", "latest"]);
  });

  it("keeps latest on the newer line when an older line gets a patch", () => {
    expect(planImageTags("0.1.1", ["0.1.0", "0.2.0"])).toEqual(["0.1.1", "0.1"]);
  });

  it("never moves X.Y or latest backwards", () => {
    expect(planImageTags("0.1.0", ["0.1.1"])).toEqual(["0.1.0"]);
    expect(planImageTags("0.1.9", ["0.1.10", "0.2.0"])).toEqual(["0.1.9"]);
  });

  it("ignores non-release tags such as commit SHAs and latest", () => {
    expect(planImageTags("0.2.0", ["latest", "0.1", "abc123", "0.1.0"])).toEqual([
      "0.2.0",
      "0.2",
      "latest",
    ]);
  });

  it("compares versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(() => compareVersions("1.0", "1.0.0")).toThrow(/X\.Y\.Z/);
  });
});

describe("image check", () => {
  const unit = imageReleaseUnitsByImage.weldall;
  // The repository license is the single source for the licenses label; `validate`
  // exports it to the workflow and `check-image` reads it back.
  const license = JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8")).license;
  const expected = { unit, platform: "linux/amd64", version: "1.2.3", revision: "abc123", license };
  const good = {
    platform: "linux/amd64",
    entrypoint: ["./entrypoint.sh"],
    labels: {
      "org.opencontainers.image.version": "1.2.3",
      "org.opencontainers.image.revision": "abc123",
      "org.opencontainers.image.licenses": license,
      "org.opencontainers.image.source": "https://github.com/seibert-external/weldall",
      "org.opencontainers.image.title": "Weldall",
      "org.opencontainers.image.created": "2026-01-01T00:00:00Z",
    },
  };

  it("indexes every unit by image name with its entrypoint", () => {
    expect(Object.keys(imageReleaseUnitsByImage).sort()).toEqual(["discovery-proxy", "weldall"]);
    for (const unit of Object.values(imageReleaseUnits)) expect(unit.entrypoint).not.toEqual([]);
  });

  it("accepts an image with the promised platform, entrypoint and labels", () => {
    expect(checkImageProblems(good, expected)).toEqual([]);
  });

  it("reports every deviation instead of stopping at the first", () => {
    const problems = checkImageProblems(
      {
        platform: "linux/arm64",
        entrypoint: ["node", "server.js"],
        labels: { ...good.labels, "org.opencontainers.image.version": "9.9.9" },
      },
      expected,
    );
    expect(problems).toEqual([
      "platform: expected linux/amd64, got linux/arm64",
      'entrypoint: expected ["./entrypoint.sh"], got ["node","server.js"]',
      'org.opencontainers.image.version: expected "1.2.3", got "9.9.9"',
    ]);
  });

  it("requires a creation time and the unit title", () => {
    const { "org.opencontainers.image.created": _created, ...labels } = good.labels;
    labels["org.opencontainers.image.title"] = "Weldall discovery proxy";
    expect(checkImageProblems({ ...good, labels }, expected)).toEqual([
      'org.opencontainers.image.title: expected "Weldall", got "Weldall discovery proxy"',
      "org.opencontainers.image.created: missing",
    ]);
  });
});

describe("published version lookup", () => {
  const response = (status: number, body?: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });

  it("follows pagination and keeps only X.Y.Z tags", async () => {
    const pages: Record<string, unknown> = {
      "https://hub.docker.com/v2/repositories/weldall/weldall/tags?page_size=100": {
        next: "https://hub.docker.com/v2/repositories/weldall/weldall/tags?page=2",
        results: [{ name: "latest" }, { name: "0.1.0" }, { name: "0.1" }],
      },
      "https://hub.docker.com/v2/repositories/weldall/weldall/tags?page=2": {
        next: null,
        results: [{ name: "0.2.0" }, { name: "deadbeef" }],
      },
    };
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return response(200, pages[url]);
    };
    await expect(
      fetchPublishedVersions("weldall/weldall", fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual(["0.1.0", "0.2.0"]);
    expect(calls).toEqual(Object.keys(pages));
  });

  it("treats a repository that does not exist yet as unpublished", async () => {
    const fetchImpl = async () => response(404);
    await expect(
      fetchPublishedVersions("weldall/new", fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual([]);
  });

  it("fails loudly on any other error instead of guessing", async () => {
    const fetchImpl = async () => response(503);
    await expect(
      fetchPublishedVersions("weldall/weldall", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe("release-docker-images workflow", () => {
  it("only starts for the two image release units", () => {
    expect(workflow).toContain("startsWith(github.event.release.tag_name, '@weldall/weldall@')");
    expect(workflow).toContain(
      "startsWith(github.event.release.tag_name, '@weldall/discovery-proxy@')",
    );
    expect(workflow).not.toContain("@weldall/cli@");
  });

  it("validates, tests and label-checks with the committed scripts", () => {
    expect(workflow).toContain("node scripts/image-release.mjs validate --tag");
    expect(workflow).toContain("node scripts/image-release.mjs plan-tags");
    expect(workflow).toContain("node scripts/image-release.mjs check-image");
    expect(workflow).toContain("sh scripts/test-weldall-image.sh");
    expect(workflow).toContain("sh apps/discovery-proxy/scripts/test-image.sh");
  });

  it("pushes only from the release environment and writes the SHA tag before floating tags", () => {
    const publish = workflow.slice(workflow.indexOf("\n  publish:"));
    expect(publish).toContain("environment: release");
    expect(publish).toContain("secrets.DOCKERHUB_TOKEN");
    expect(workflow.slice(0, workflow.indexOf("\n  publish:"))).not.toContain("secrets.");
    const pushSha = publish.indexOf("Push the immutable commit-SHA tag first");
    const moveFloating = publish.indexOf("Move the floating tags");
    expect(pushSha).toBeGreaterThan(-1);
    expect(moveFloating).toBeGreaterThan(pushSha);
  });
});
