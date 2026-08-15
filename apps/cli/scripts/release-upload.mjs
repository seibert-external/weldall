import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { archiveNameFor, standaloneTargets } from "./standalone-targets.mjs";

const cliTagPattern =
  /^@weldall\/cli@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

export function parseCliReleaseTag(tag) {
  const match = cliTagPattern.exec(tag);
  if (!match)
    throw new Error(`Expected an exact @weldall/cli@X.Y.Z release tag; got ${JSON.stringify(tag)}`);
  archiveNameFor(standaloneTargets[0], match[1]);
  return match[1];
}

export function expectedReleaseAssetNames(tag, includeChecksums = true) {
  const version = parseCliReleaseTag(tag);
  const names = standaloneTargets.map((target) => archiveNameFor(target, version));
  if (includeChecksums) names.push("SHA256SUMS");
  return names.sort((left, right) => left.localeCompare(right, "en"));
}

export function validateAssetPaths(paths, tag, includeChecksums = true) {
  const expected = expectedReleaseAssetNames(tag, includeChecksums);
  const actual = paths
    .map((path) => basename(path))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(actual).size !== actual.length)
    throw new Error(`Release asset paths contain duplicate basenames: ${actual.join(", ")}`);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `Release assets differ from the exact expected set\nExpected: ${expected.join(", ")}\nActual: ${actual.join(", ")}`,
    );
  return expected;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function responseError(response, operation) {
  const body = await response.text().catch(() => "");
  throw new Error(`${operation} failed with HTTP ${response.status}${body ? `: ${body}` : ""}`);
}

async function existingAssetHash(asset, fetchImpl, headers) {
  if (typeof asset.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(asset.digest))
    return asset.digest.slice("sha256:".length);
  if (!asset.url)
    throw new Error(
      `Existing asset ${asset.name} has neither a SHA-256 digest nor an API download URL`,
    );
  const response = await fetchImpl(asset.url, {
    headers: { ...headers, Accept: "application/octet-stream" },
  });
  if (!response.ok) await responseError(response, `Download of existing asset ${asset.name}`);
  return sha256(Buffer.from(await response.arrayBuffer()));
}

export async function syncReleaseAssets({
  owner,
  repo,
  tag,
  assetPaths,
  token,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  log = console.log,
}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error("GitHub owner and repository must be simple names");
  validateAssetPaths(assetPaths, tag, true);
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  if (!token) throw new Error("A GitHub token is required to inspect the release safely");

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const releaseResponse = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    { headers },
  );
  if (!releaseResponse.ok) await responseError(releaseResponse, `Release lookup for ${tag}`);
  const release = await releaseResponse.json();
  if (release.tag_name !== tag)
    throw new Error(
      `GitHub returned release tag ${JSON.stringify(release.tag_name)} instead of ${tag}`,
    );
  if (!Array.isArray(release.assets)) throw new Error("GitHub release response has no asset list");

  const expectedNames = new Set(expectedReleaseAssetNames(tag));
  const existing = new Map();
  for (const asset of release.assets) {
    if (!expectedNames.has(asset.name)) continue;
    if (existing.has(asset.name))
      throw new Error(`Release contains duplicate asset ${JSON.stringify(asset.name)}`);
    existing.set(asset.name, asset);
  }

  const uploaded = [];
  const skipped = [];
  const recovered = [];
  for (const path of assetPaths) {
    const name = basename(path);
    const bytes = await readFile(path);
    const localHash = sha256(bytes);
    const current = existing.get(name);
    if (current && current.size === 0 && current.state === "starter") {
      if (dryRun) {
        log(`Dry run: would delete failed zero-byte starter asset ${name} and retry its upload`);
      } else {
        if (typeof current.url !== "string" || !current.url)
          throw new Error(`Failed starter asset ${name} has no API URL for safe deletion`);
        log(`Deleting failed zero-byte starter asset before retry: ${name}`);
        const response = await fetchImpl(current.url, { method: "DELETE", headers });
        if (!response.ok) await responseError(response, `Deletion of failed starter asset ${name}`);
        recovered.push(name);
      }
    } else if (current) {
      const remoteHash = await existingAssetHash(current, fetchImpl, headers);
      if (remoteHash !== localHash)
        throw new Error(
          `Existing release asset ${name} has SHA-256 ${remoteHash}, expected ${localHash}; refusing to clobber it`,
        );
      skipped.push(name);
      log(`Identical release asset already exists: ${name}`);
      continue;
    }

    if (dryRun) {
      log(`Dry run: would upload ${name} (${localHash})`);
      continue;
    }
    const uploadBase = String(release.upload_url ?? "").replace(/\{.*$/, "");
    if (!uploadBase) throw new Error("GitHub release response has no upload_url");
    const response = await fetchImpl(`${uploadBase}?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.length),
      },
      body: bytes,
    });
    if (!response.ok) await responseError(response, `Upload of ${name}`);
    uploaded.push(name);
    log(`Uploaded release asset: ${name}`);
  }
  return { uploaded, skipped, recovered, dryRun };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const tagIndex = args.indexOf("--tag");
  const tag = tagIndex === -1 ? undefined : args[tagIndex + 1];
  const paths = args.filter(
    (_, index) => index !== tagIndex && index !== tagIndex + 1 && args[index] !== "--dry-run",
  );
  if (!tag) throw new Error("A strict --tag @weldall/cli@X.Y.Z argument is required");

  if (command === "validate-archives") {
    validateAssetPaths(paths, tag, false);
    console.log(`Validated exact archive set for ${tag}`);
    return;
  }
  if (command !== "upload" || paths.length === 0)
    throw new Error(
      "Usage: node release-upload.mjs upload --tag @weldall/cli@X.Y.Z [--dry-run] <four archives> SHA256SUMS",
    );
  const repository = process.env.GITHUB_REPOSITORY?.split("/");
  if (repository?.length !== 2) throw new Error("GITHUB_REPOSITORY must be owner/repository");
  await syncReleaseAssets({
    owner: repository[0],
    repo: repository[1],
    tag,
    assetPaths: paths,
    token: process.env.GITHUB_TOKEN,
    dryRun: args.includes("--dry-run"),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
