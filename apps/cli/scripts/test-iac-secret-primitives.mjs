#!/usr/bin/env node
// Explicit local-only smoke: uses the built workspace CLI and a disposable workspace on the running dev server.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { generateEs256KeyPair } from "@weldall/sdk";
import { calculateJwkThumbprint } from "jose";
import { parse, stringify } from "yaml";
import { db } from "../../../packages/db/dist/index.js";

const issuer = "https://weldall.seibert.localdev";
const database = new URL(process.env.POSTGRES_URL ?? "postgresql://invalid");
assert.equal(
  database.host,
  "localhost:5433",
  "Only the explicitly selected local development database is permitted",
);
assert.equal(
  database.pathname,
  "/postgres",
  "Only the local development installation is permitted",
);
const metadata = await fetch(`${issuer}/.well-known/oauth-authorization-server`).then((r) =>
  r.json(),
);
assert.equal(metadata.issuer, issuer);
assert(
  metadata.weldall_iac?.features?.includes("iac-ui-secrets-v1"),
  "Restart/upgrade the local server first",
);
assert.equal(
  (await db.installationIdentity.findUniqueOrThrow({ where: { id: "default" } })).installationId,
  metadata.weldall_iac.installationId,
);
const prefix = `iac-smoke-${randomUUID().slice(0, 8)}`;
const owner = await db.user.findUniqueOrThrow({
  where: { email: "alice@example.com" },
  select: { email: true },
});
const keys = await generateEs256KeyPair();
const env = {
  ...process.env,
  WELDALL_M2M_CLIENT_ID: prefix,
  WELDALL_M2M_KID: "smoke",
  WELDALL_M2M_PRIVATE_JWK: JSON.stringify(keys.privateJwk),
  WELDALL_M2M_PUBLIC_JWK: JSON.stringify(keys.publicJwk),
};
const root = await mkdtemp(join(tmpdir(), "weldall-live-iac-"));
const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const run = (...args) =>
  execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90_000,
  });
let workspaceId;
const loginId = randomUUID();
try {
  await db.machineClient.create({
    data: {
      clientId: prefix,
      name: "Local IaC smoke",
      createdBy: prefix,
      updatedBy: prefix,
      keys: {
        create: {
          kid: "smoke",
          publicJwk: keys.publicJwk,
          thumbprint: await calculateJwkThumbprint(keys.publicJwk),
          createdBy: prefix,
        },
      },
      allowedScopes: { create: { scope: { connect: { key: "weldall:iac" } } } },
    },
  });
  run("init", "--issuer", issuer, "--name", prefix);
  workspaceId = parse(await readFile(join(root, "weldall.lock.yml"), "utf8")).workspace.id;
  const value = {
    apiVersion: "weldall.dev/v1",
    workspace: { name: prefix, issuer },
    scopes: { use: { key: `${prefix}:use`, description: "Local smoke" } },
    connectors: {
      mcp: {
        key: prefix,
        name: "Local smoke MCP",
        type: "atlassian-mcp",
        enabled: false,
        envelopeProvider: "LOCAL_ENV",
        requiredScopes: [],
        provider: { allowedScopes: ["read:jira:agent-interface"], defaultScopes: [] },
      },
    },
    sharedConnections: {
      bot: {
        key: prefix,
        connectorKey: prefix,
        name: "Local smoke bot",
        enabled: false,
        useScopes: [`${prefix}:use`],
        credentialManagerEmail: owner.email,
        serviceAccountLabel: "Local smoke",
        provider: { kind: "service-account-api-key", cloudIds: [] },
      },
    },
    groupProviders: {
      directory: {
        key: prefix,
        name: "Local smoke directory",
        adapterType: "management-api-v1",
        baseUrl: "https://directory.example.com",
        enabled: false,
      },
    },
    loginProviders: {
      sso: {
        id: loginId,
        name: "Local smoke SSO",
        buttonLabel: "Local smoke login",
        buttonColor: "#112233",
        issuer: "https://dev-idp.seibert.localdev",
        clientId: "smoke-client",
        tokenEndpointAuthMethod: "client_secret_post",
        enabled: false,
      },
    },
  };
  const save = (manifest) => writeFile(join(root, "weldall.yml"), stringify(manifest));
  await save(value);
  assert(JSON.parse(run("validate", "--json")).valid);
  const planned = JSON.parse(run("plan", "--json"));
  assert.deepEqual(planned.blockers, []);
  assert.equal(planned.actions.filter((a) => a.action === "create").length, 5);
  console.log(run("up", "--yes").trim());
  assert(JSON.parse(run("plan", "--json")).actions.every((a) => a.action === "noop"));
  const originals = {
    shared: await db.connection.findUniqueOrThrow({ where: { key: prefix } }),
    group: await db.groupProvider.findUniqueOrThrow({ where: { key: prefix } }),
    login: await db.loginProvider.findUniqueOrThrow({ where: { id: loginId } }),
  };
  assert.equal(originals.shared.credentialId, null);
  assert.equal(originals.shared.enabled, false);
  assert.equal(originals.group.encryptedToken, null);
  assert.equal(originals.login.encryptedClientSecret, null);
  const enabled = structuredClone(value);
  enabled.sharedConnections.bot.enabled = true;
  enabled.groupProviders.directory.enabled = true;
  enabled.loginProviders.sso.enabled = true;
  await save(enabled);
  assert.equal(
    JSON.parse(run("plan", "--json")).blockers.filter((b) => b.code === "MISSING_CREDENTIAL")
      .length,
    3,
  );
  assert.throws(() => run("up", "--yes"));
  await save(value);
  for (const [kind, section, name, identity] of [
    ["connector", "connectors", "mcp", prefix],
    ["sharedConnection", "sharedConnections", "bot", prefix],
    ["groupProvider", "groupProviders", "directory", prefix],
    ["loginProvider", "loginProviders", "sso", loginId],
  ]) {
    delete value[section][name];
    await save(value);
    run("unmanage", `${kind}.${name}`, "--yes");
    run("import", kind, identity, "--as", `${kind}.${name}`);
    // Imports add public fragments/includes; reload the root without losing those includes.
    Object.assign(value, parse(await readFile(join(root, "weldall.yml"), "utf8")));
    assert(JSON.parse(run("plan", "--json")).actions.every((a) => a.action === "noop"));
  }
  run("state", "pull");
  assert.deepEqual(
    await db.connection.findUnique({ where: { id: originals.shared.id } }),
    originals.shared,
  );
  assert.deepEqual(
    await db.groupProvider.findUnique({ where: { id: originals.group.id } }),
    originals.group,
  );
  assert.deepEqual(await db.loginProvider.findUnique({ where: { id: loginId } }), originals.login);
  const clean = {
    apiVersion: value.apiVersion,
    workspace: value.workspace,
    sharedConnections: {},
    groupProviders: {},
    loginProviders: {},
  };
  await save(clean);
  console.log(run("up", "--yes").trim());
  assert.equal(await db.iacObjectBinding.count({ where: { workspaceId } }), 0);
  console.log(
    "PASS: local built CLI → live HTTPS server: draft apply, no-op, missing-credential blockers, import/unmanage of all four kinds, credential/identity preservation, state pull and dependency-safe deletion.",
  );
  // Optional second pass over explicitly identified, disposable UI-provisioned fixtures.
  // Usage: --ui-fixtures <connector/group/shared-key> <login-provider-uuid>
  if (process.argv[2] === "--ui-fixtures") {
    const [uiKey, uiLoginId] = process.argv.slice(3);
    assert(uiKey?.startsWith("iac-ui-check-"));
    assert.match(uiLoginId ?? "", /^[0-9a-f-]{36}$/);
    const rows = async () =>
      Promise.all([
        db.connector.findUniqueOrThrow({ where: { key: uiKey } }),
        db.connection.findUniqueOrThrow({ where: { key: uiKey }, include: { credential: true } }),
        db.groupProvider.findUniqueOrThrow({ where: { key: uiKey } }),
        db.loginProvider.findUniqueOrThrow({ where: { id: uiLoginId } }),
      ]);
    const before = await rows();
    assert(
      before.every((row) => row.name === "IaC UI check"),
      "Use only disposable UI fixtures",
    );
    const targets = [
      ["connector", "connectors", uiKey],
      ["sharedConnection", "sharedConnections", uiKey],
      ["groupProvider", "groupProviders", uiKey],
      ["loginProvider", "loginProviders", uiLoginId],
    ];
    const manifest = structuredClone(clean);
    for (const [kind, section, identity] of targets) {
      run("import", kind, identity, "--as", `${kind}.ui_fixture`);
      Object.assign(
        manifest,
        parse(await readFile(join(root, "weldall", "imports", `${kind}-ui_fixture.yml`), "utf8")),
      );
      assert(JSON.parse(run("plan", "--json")).actions.every((a) => a.action === "noop"));
      assert(
        JSON.stringify(await rows()) === JSON.stringify(before),
        "Import must preserve rows and credentials byte-for-byte",
      );
    }
    // Inline the imported public values for activation; credentials are never copied to YAML.
    for (const [, section] of targets) manifest[section].ui_fixture.enabled = true;
    await save(manifest);
    const activation = JSON.parse(run("plan", "--json"));
    assert.deepEqual(activation.blockers, []);
    assert(activation.actions.some((a) => a.requiresAuthorityConfirmation));
    assert.throws(() => run("up", "--yes"));
    assert(
      JSON.stringify(await rows()) === JSON.stringify(before),
      "Unapproved activation must not mutate anything",
    );
    run("up", "--yes", "--acknowledge-authority", activation.digest);
    assert((await rows()).every((row) => row.enabled));
    assert((await fetch(`${issuer}/login`).then((r) => r.text())).includes(before[3].buttonLabel));
    for (const [, section] of targets) manifest[section].ui_fixture.enabled = false;
    await save(manifest);
    run("up", "--yes");
    assert((await rows()).every((row) => !row.enabled));
    assert(!(await fetch(`${issuer}/login`).then((r) => r.text())).includes(before[3].buttonLabel));
    for (const [index, [, section]] of targets.entries())
      manifest[section].ui_fixture.enabled = before[index].enabled;
    await save(manifest);
    const restore = JSON.parse(run("plan", "--json"));
    run("up", "--yes", "--acknowledge-authority", restore.digest);
    const after = await rows();
    assert(
      after.every(
        (row, index) => row.id === before[index].id && row.enabled === before[index].enabled,
      ),
    );
    assert(
      after[0].encryptedProviderSecrets === before[0].encryptedProviderSecrets,
      "Connector secret preserved",
    );
    assert(
      after[1].credentialId === before[1].credentialId &&
        JSON.stringify(after[1].credential) === JSON.stringify(before[1].credential),
      "Connection credential preserved",
    );
    assert(after[1].ownerId === before[1].ownerId, "Custodian preserved");
    assert(after[2].encryptedToken === before[2].encryptedToken, "Group credential preserved");
    assert(
      after[3].encryptedClientSecret === before[3].encryptedClientSecret,
      "Login credential preserved",
    );
    await save(clean);
    for (const [kind] of targets) run("unmanage", `${kind}.ui_fixture`, "--yes");
    assert(
      JSON.stringify(await rows()) === JSON.stringify(after),
      "Unmanage preserves the objects and credentials",
    );
    console.log(
      "PASS: UI-provisioned fixtures imported unchanged, activation requires current-plan authority approval, enable/disable/re-enable preserves credentials, login visibility follows activation, unmanage preserves all four objects.",
    );
    if (process.argv[5] === "--delete-ui-fixtures") {
      for (const [kind, , identity] of targets)
        run("import", kind, identity, "--as", `${kind}.ui_fixture`);
      await save(clean);
      run("up", "--yes");
      assert.equal(await db.encryptedValue.count({ where: { id: before[1].credentialId } }), 0);
      console.log(
        "PASS: disposable UI fixtures deleted through live CLI, including the stored connection credential.",
      );
    }
  }
} finally {
  // Only uniquely named fixtures from this invocation; never reset or seed the user's installation.
  if (workspaceId) await db.iacWorkspace.deleteMany({ where: { id: workspaceId, name: prefix } });
  await db.connection.deleteMany({ where: { key: prefix, credentialId: null } });
  await db.connector.deleteMany({ where: { key: prefix } });
  await db.groupProvider.deleteMany({ where: { key: prefix } });
  await db.loginProvider.deleteMany({ where: { id: loginId } });
  await db.scope.deleteMany({ where: { key: `${prefix}:use` } });
  await db.machineClient.deleteMany({ where: { clientId: prefix } });
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
}
