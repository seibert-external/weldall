import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const workspace = process.env.WELDALL_E2E_WORKSPACE ?? "/workspace";
const credentialsFile = "/tmp/weldall-e2e-credentials.json";
const browserUrlFile = "/tmp/weldall-e2e-browser-url";
const cli = join(workspace, "apps/cli/dist/index.js");
const cliEnv = {
  ...process.env,
  NODE_ENV: "test",
  WELDALL_ISSUER: "https://weldall.seibert.localdev",
  WELDALL_E2E_CREDENTIALS_FILE: credentialsFile,
  WELDALL_E2E_BROWSER_URL_FILE: browserUrlFile,
  PATH: `${join(workspace, "e2e/bin")}:${process.env.PATH ?? ""}`,
};

type CliResult = { code: number; stdout: string; stderr: string };

const startCli = (args: string[]) => {
  const child = spawn(process.execPath, ["--use-system-ca", cli, ...args], {
    cwd: workspace,
    env: cliEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const result = new Promise<CliResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: weldall ${args.join(" ")}`));
    }, 45_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
  return { child, result };
};

const runCli = async (...args: string[]) => {
  const { result } = startCli(args);
  return result;
};

const waitForBrowserUrl = async () => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const value = await readFile(browserUrlFile, "utf8");
      if (value.startsWith("https://")) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("CLI did not invoke the browser opener");
};

test.beforeEach(async () => {
  await Promise.all([rm(credentialsFile, { force: true }), rm(browserUrlFile, { force: true })]);
});

test("runs login, skill discovery, a DPoP request, and logout end to end", async ({ page }) => {
  const login = startCli(["login"]);
  await page.goto(await waitForBrowserUrl());
  await page.getByRole("button", { name: "Development login" }).click();
  await expect(page.getByRole("heading", { name: "Insecure development login" })).toBeVisible();
  await page.getByLabel("Email").selectOption("alice@example.com");
  await page.getByRole("button", { name: "Continue" }).click();

  const loginResult = await login.result;
  expect(loginResult, loginResult.stderr).toMatchObject({ code: 0 });
  expect(loginResult.stdout).toContain("Logged in as");

  const whoami = await runCli("whoami", "--json");
  expect(whoami, whoami.stderr).toMatchObject({ code: 0 });
  expect(JSON.parse(whoami.stdout)).toMatchObject({
    issuer: "https://weldall.seibert.localdev",
    subject: expect.any(String),
    name: "Alice E2E",
    email: "alice@example.com",
  });
  const whoamiText = await runCli("whoami");
  expect(whoamiText, whoamiText.stderr).toMatchObject({ code: 0 });
  expect(whoamiText.stdout).toContain("Signed in as Alice E2E");
  expect(whoamiText.stdout).toContain("Email        alice@example.com");

  await page.goto("https://weldall.seibert.localdev/scopes");
  await expect(page.getByRole("heading", { name: "Scopes" })).toBeVisible();
  await expect(page.getByText("weldall:administer", { exact: true })).toBeVisible();
  await expect(page.getByText("expenses:read", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Create scope" }).click();
  const scopeDialog = page.getByRole("dialog");
  await scopeDialog.getByLabel("Scope key").fill("e2e:temporary");
  await scopeDialog.getByLabel("Description").fill("Temporary E2E scope");
  await scopeDialog.getByRole("button", { name: "Create scope" }).click();
  const temporaryScopeRow = page.getByRole("row").filter({ hasText: "e2e:temporary" });
  await expect(temporaryScopeRow).toBeVisible();
  await temporaryScopeRow.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete scope" }).click();
  await expect(temporaryScopeRow).toHaveCount(0);

  await page.getByRole("link", { name: "Assignments" }).click();
  await expect(page.getByRole("heading", { name: "Email assignments" })).toBeVisible();
  const aliceRow = page.getByRole("row").filter({ hasText: "alice@example.com" });
  await expect(aliceRow).toBeVisible();
  await aliceRow.getByRole("button", { name: "Edit" }).click();
  const assignmentDialog = page.getByRole("dialog");
  await assignmentDialog.getByRole("button", { name: "Scopes", exact: true }).click();
  await page.getByRole("option", { name: "Select all" }).click();
  await assignmentDialog.getByRole("button", { name: "Save assignment" }).click();
  await expect(aliceRow.getByText("expenses:read", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Skill registry" }).click();
  await expect(page.getByRole("heading", { name: "Skill registry" })).toBeVisible();
  await page.getByRole("link", { name: "Create skill" }).click();
  await page.getByLabel("Skill ID").fill("expenses.list");
  await page.getByLabel("Title").fill("List expenses");
  await page.getByRole("button", { name: "Required scopes" }).click();
  await page.getByRole("option", { name: /expenses:read/ }).click();
  await page
    .getByLabel("Markdown instructions")
    .fill(
      "Load expenses with `weldall request --scope expenses:read https://expenses.seibert.localdev/api/expenses`.",
    );
  await page.getByRole("button", { name: "Create skill" }).click();
  await expect(page.getByRole("row").filter({ hasText: "expenses.list" })).toBeVisible();

  const scopes = await runCli("scopes", "--resource", "expenses");
  expect(scopes, scopes.stderr).toMatchObject({ code: 0 });
  expect(scopes.stdout.trim().split("\n").sort()).toEqual([
    "expenses:create",
    "expenses:delete",
    "expenses:read",
    "expenses:write",
  ]);

  const skills = await runCli("skills");
  expect(skills, skills.stderr).toMatchObject({ code: 0 });
  expect(skills.stdout).toContain("expenses.list\tList expenses\tavailable");
  const skill = await runCli("skills", "show", "expenses.list");
  expect(skill, skill.stderr).toMatchObject({ code: 0 });
  expect(skill.stdout).toContain("requiredScopes:");
  expect(skill.stdout).toContain("weldall request --scope expenses:read");

  const request = await runCli(
    "request",
    "--scope",
    "expenses:read",
    "https://expenses.seibert.localdev/api/expenses",
  );
  expect(request, request.stderr).toMatchObject({ code: 0 });
  expect(JSON.parse(request.stdout)).toMatchObject({
    expenses: [{ id: "expense-1" }],
    subject: expect.any(String),
  });

  await page.getByRole("link", { name: "CLI", exact: true }).click();
  await expect(page.getByRole("heading", { name: "CLI", exact: true })).toBeVisible();
  const appendix = "Gude! Use Weldall for everything related to Seibert.";
  await page.getByLabel("CLI appendix").fill(appendix);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("CLI settings saved", { exact: true })).toBeVisible();
  for (const help of [await runCli(), await runCli("--help")]) {
    expect(help, help.stderr).toMatchObject({ code: 0 });
    expect(help.stdout).toContain(appendix);
    expect(help.stdout).toContain("USAGE:");
  }

  const logout = await runCli("logout");
  expect(logout, logout.stderr).toMatchObject({ code: 0 });
  expect(logout.stdout).toContain("Logged out.");
  const afterLogout = await runCli("scopes");
  expect(afterLogout.code).toBe(1);
  expect(afterLogout.stderr).toContain("not logged in");
});

test("publishes metadata and rejects unauthenticated or unsupported requests", async ({
  request,
}) => {
  const [weldallMetadata, expensesMetadata, unauthenticated, bearer, unsupportedGrant] =
    await Promise.all([
      request.get("https://weldall.seibert.localdev/.well-known/oauth-authorization-server"),
      request.get("https://expenses.seibert.localdev/.well-known/oauth-authorization-server"),
      request.get("https://expenses.seibert.localdev/api/expenses"),
      request.get("https://expenses.seibert.localdev/api/expenses", {
        headers: { authorization: "Bearer stolen-token" },
      }),
      request.post("https://expenses.seibert.localdev/oauth/token", {
        form: { grant_type: "urn:example:unsupported" },
      }),
    ]);
  expect(weldallMetadata.ok()).toBe(true);
  expect(await weldallMetadata.json()).toMatchObject({
    issuer: "https://weldall.seibert.localdev",
    scopes_supported: expect.arrayContaining(["profile", "email"]),
  });
  expect(expensesMetadata.ok()).toBe(true);
  expect(await expensesMetadata.json()).toMatchObject({
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-dpop"],
  });
  expect(unauthenticated.status()).toBe(401);
  expect(bearer.status()).toBe(401);
  expect(unsupportedGrant.status()).toBe(400);
});
