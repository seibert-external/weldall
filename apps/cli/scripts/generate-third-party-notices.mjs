import { createRequire } from "node:module";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bunLicensePath = join(cliRoot, "licenses", "BUN-1.3.14-LICENSE.md");
const licenseName = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;

function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, "\n");
}

async function packageJsonPath(name, fromRoot) {
  try {
    return await realpath(join(fromRoot, "node_modules", name, "package.json"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const require = createRequire(join(fromRoot, "package.json"));
  for (const searchPath of require.resolve.paths(name) ?? []) {
    try {
      return await realpath(join(searchPath, name, "package.json"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  try {
    return await realpath(require.resolve(`${name}/package.json`));
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    let directory = dirname(await realpath(require.resolve(name)));
    for (;;) {
      const candidate = join(directory, "package.json");
      try {
        const value = JSON.parse(await readFile(candidate, "utf8"));
        if (value.name === name) return candidate;
      } catch (candidateError) {
        if (candidateError?.code !== "ENOENT") throw candidateError;
      }
      const parent = dirname(directory);
      if (parent === directory) throw error;
      directory = parent;
    }
  }
}

async function installedDependency(name, fromRoot, optional) {
  try {
    const jsonPath = await packageJsonPath(name, fromRoot);
    return {
      jsonPath,
      root: dirname(jsonPath),
      json: JSON.parse(await readFile(jsonPath, "utf8")),
    };
  } catch (error) {
    if (optional && error?.code === "MODULE_NOT_FOUND") return undefined;
    throw new Error(`Unable to resolve production dependency ${name} from ${fromRoot}`, {
      cause: error,
    });
  }
}

async function productionInventory() {
  const cliJson = JSON.parse(await readFile(join(cliRoot, "package.json"), "utf8"));
  const pending = Object.keys({ ...cliJson.dependencies, ...cliJson.optionalDependencies }).map(
    (name) => ({ name, fromRoot: cliRoot, optional: name in (cliJson.optionalDependencies ?? {}) }),
  );
  const packages = new Map();
  while (pending.length) {
    const request = pending.shift();
    const dependency = await installedDependency(request.name, request.fromRoot, request.optional);
    if (!dependency) continue;
    const key = await realpath(dependency.root);
    if (packages.has(key)) continue;
    packages.set(key, dependency);
    for (const name of Object.keys(dependency.json.dependencies ?? {}))
      pending.push({ name, fromRoot: dependency.root, optional: false });
    for (const name of Object.keys(dependency.json.optionalDependencies ?? {}))
      pending.push({ name, fromRoot: dependency.root, optional: true });
  }
  const inventory = [...packages.values()];
  const keyring = inventory.find(({ json }) => json.name === "@napi-rs/keyring");
  for (const [name, version] of Object.entries(keyring?.json.optionalDependencies ?? {})) {
    if (!inventory.some(({ json }) => json.name === name))
      inventory.push({ root: undefined, json: { name, version } });
  }
  return inventory.sort((left, right) =>
    `${left.json.name}@${left.json.version}`.localeCompare(
      `${right.json.name}@${right.json.version}`,
      "en",
    ),
  );
}

async function licenseFiles(dependency, inventory) {
  // The platform keyring artifacts are published from the same repository without
  // duplicating its LICENSE file. Use the installed parent package's exact text.
  if (/^@napi-rs\/keyring-/.test(dependency.json.name)) {
    const parent = inventory.find(({ json }) => json.name === "@napi-rs/keyring");
    if (parent) {
      const inherited = await licenseFiles(parent, inventory);
      if (inherited.length)
        return inherited.map(({ name, content }) => ({
          name: `@napi-rs/keyring/${name}`,
          content,
        }));
    }
  }

  const names = (await readdir(dependency.root)).filter((name) => licenseName.test(name)).sort();
  if (names.length)
    return Promise.all(
      names.map(async (name) => ({
        name,
        content: normalizeLineEndings(await readFile(join(dependency.root, name), "utf8")),
      })),
    );

  const vendoredName = `${dependency.json.name}@${dependency.json.version}-LICENSE`;
  try {
    return [
      {
        name: `vendored/${vendoredName}`,
        content: normalizeLineEndings(
          await readFile(join(cliRoot, "licenses", "npm", vendoredName), "utf8"),
        ),
      },
    ];
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  throw new Error(
    `Production dependency ${dependency.json.name}@${dependency.json.version} has no LICENSE, COPYING, or NOTICE text`,
  );
}

export async function generateThirdPartyNotice() {
  const inventory = await productionInventory();
  const sections = [
    "Weldall CLI third-party notices",
    "================================",
    "",
    "This file is generated deterministically from the installed @weldall/cli production dependency closure.",
    "All keyring platform bindings are included conservatively so the output is identical on every build host.",
    "License and notice texts below are reproduced verbatim from the installed packages or pinned vendored sources.",
    "",
  ];
  for (const dependency of inventory) {
    sections.push(`${dependency.json.name}@${dependency.json.version}`, "-".repeat(80));
    for (const file of await licenseFiles(dependency, inventory)) {
      sections.push(`[${file.name}]`, file.content.trimEnd(), "");
    }
  }
  sections.push("Bun 1.3.14", "-".repeat(80), `[${basename(bunLicensePath)}]`);
  sections.push(normalizeLineEndings(await readFile(bunLicensePath, "utf8")).trimEnd(), "");
  return `${sections.join("\n").trimEnd()}\n`;
}

export async function writeThirdPartyNotice(output = join(cliRoot, "THIRD_PARTY_NOTICES")) {
  const notice = await generateThirdPartyNotice();
  await writeFile(output, notice);
  return output;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--check")) {
    const generated = await generateThirdPartyNotice();
    const committed = normalizeLineEndings(
      await readFile(join(cliRoot, "THIRD_PARTY_NOTICES"), "utf8"),
    );
    if (generated !== committed)
      throw new Error("Committed THIRD_PARTY_NOTICES differs from generated production notices");
    console.log("Committed THIRD_PARTY_NOTICES equals generated production notices");
  } else {
    const outputIndex = process.argv.indexOf("--output");
    const output = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
    console.log(await writeThirdPartyNotice(output));
  }
}
