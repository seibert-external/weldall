import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

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
};

type CliResult = { code: number; stdout: string; stderr: string };

const activeCliChildren = new Set<ChildProcess>();

const terminateCliChild = async (child: ChildProcess) => {
  await new Promise<void>((resolve) => {
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const finished = () => {
      if (forceTimer) clearTimeout(forceTimer);
      resolve();
    };
    child.once("close", finished);
    if (child.exitCode !== null || child.signalCode !== null) {
      finished();
      return;
    }
    forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.kill("SIGTERM");
  });
};

const normalizePanelOutput = (output: string) =>
  output
    .replace(/[\u2500-\u257f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const startCli = (args: string[], timeoutMs = 45_000) => {
  const child = spawn(process.execPath, ["--use-system-ca", cli, ...args], {
    cwd: workspace,
    env: cliEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeCliChildren.add(child);
  child.once("close", () => activeCliChildren.delete(child));
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const result = new Promise<CliResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: weldall ${args.join(" ")}`));
    }, timeoutMs);
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

const describeCliResult = ({ code, stdout, stderr }: CliResult) =>
  [`exit code: ${code}`, `stdout:\n${stdout || "(empty)"}`, `stderr:\n${stderr || "(empty)"}`].join(
    "\n",
  );

const waitForBrowserUrl = async (login: ReturnType<typeof startCli>) => {
  // The public welcome page no longer prewarms login during the stack health check,
  // so OAuth discovery and authorization may compile cold on a loaded CI runner.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const event = await Promise.race([
      readFile(browserUrlFile, "utf8")
        .then((value) => ({ type: "browser-url" as const, value }))
        .catch(() => ({ type: "pending" as const })),
      login.result.then((result) => ({ type: "cli-exit" as const, result })),
      new Promise<{ type: "pending" }>((resolve) =>
        setTimeout(() => resolve({ type: "pending" }), 50),
      ),
    ]);
    if (event.type === "browser-url" && event.value.startsWith("https://")) return event.value;
    if (event.type === "cli-exit")
      throw new Error(
        `CLI exited before invoking the browser opener.\n${describeCliResult(event.result)}`,
      );
  }
  login.child.kill("SIGTERM");
  const result = await login.result;
  throw new Error(
    `CLI did not invoke the browser opener within 90 seconds.\n${describeCliResult(result)}`,
  );
};

const openDevelopmentLogin = async (page: Page, login: ReturnType<typeof startCli>) => {
  const sessionProbe = page.waitForResponse((response) =>
    response.url().includes("/api/auth/get-session"),
  );
  await page.goto(await waitForBrowserUrl(login));
  // A cold dev-server compile can deliver the SSR HTML before React hydrates, so
  // a click that lands pre-hydration silently no-ops (the sign-in request never
  // reaches the server). The session probe is fired by a client effect once the
  // React root has mounted, so waiting for it guarantees the click reaches its
  // handler even on a loaded CI runner.
  await sessionProbe;
  await page.getByRole("button", { name: "Development login" }).click();
};

test.beforeEach(async () => {
  await Promise.all([rm(credentialsFile, { force: true }), rm(browserUrlFile, { force: true })]);
});

test.afterEach(async () => {
  await Promise.all([...activeCliChildren].map(terminateCliChild));
});

test("runs login, skill discovery, a DPoP request, and logout end to end", async ({
  page,
  request: apiRequest,
}) => {
  // This scenario intentionally crosses many lazily compiled admin and authenticated API routes.
  // Loaded CI runners have taken over four minutes before reaching the CLI skill checks alone.
  test.setTimeout(480_000);

  const login = startCli(["login"], 150_000);
  await openDevelopmentLogin(page, login);
  await expect(page.getByRole("heading", { name: "Insecure development login" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByLabel("Email").selectOption("alice@example.com");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Login to Weldall CLI" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Only approve if you started this login")).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();

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
  const normalizedWhoami = normalizePanelOutput(whoamiText.stdout);
  expect(normalizedWhoami).toContain("Account Alice E2E");
  expect(normalizedWhoami).toContain("Email alice@example.com");

  await page.goto("https://weldall.seibert.localdev/admin/scopes");
  await expect(page.getByRole("heading", { name: "Scopes" })).toBeVisible();
  const scopeSearch = page.getByRole("textbox", { name: "Find scopes" });
  for (const scope of ["weldall:administer", "weldall:login", "expenses:read"]) {
    await scopeSearch.fill(scope);
    await expect(
      page.getByRole("row").filter({ has: page.getByText(scope, { exact: true }) }),
    ).toBeVisible();
  }
  await scopeSearch.clear();

  await page.getByRole("button", { name: "Create scope" }).click();
  const scopeDialog = page.getByRole("dialog");
  await scopeDialog.getByLabel("Scope key").fill("e2e:temporary");
  await scopeDialog.getByLabel("Description").fill("Temporary E2E scope");
  await scopeDialog.getByRole("button", { name: "Create scope" }).click();
  const temporaryScopeRow = page.getByRole("row").filter({ hasText: "e2e:temporary" });
  await expect(temporaryScopeRow).toBeVisible();
  await temporaryScopeRow.click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete scope" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete scope" }).click();
  await expect(temporaryScopeRow).toHaveCount(0);

  await page.getByRole("link", { name: "Resources" }).click();
  await expect(page.getByRole("heading", { name: "Resources" })).toBeVisible();
  await page.getByRole("link", { name: "Create resource" }).click();
  await page.getByLabel("Resource key").fill("reports");
  await page.getByLabel("Name").fill("Reports");
  await page.getByLabel("Resource identifier").fill("https://reports.seibert.localdev/api");
  await page.getByLabel("Authorization server").fill("https://reports.seibert.localdev");
  await page.getByLabel("Downstream client ID").fill("weldall-cli-at-reports");
  await page.getByLabel("Request prefixes").fill("https://reports.seibert.localdev/api");
  await page.getByRole("button", { name: "Supported scopes" }).click();
  await expect(page.getByRole("option", { name: "weldall:login" })).toBeVisible();
  await expect(page.getByRole("option", { name: "weldall:administer" })).toBeVisible();
  await page.getByRole("option", { name: "expenses:read" }).click();
  await page.getByRole("button", { name: "Create resource" }).click();
  await expect(page.getByRole("row").filter({ hasText: "reports" })).toBeVisible();

  const expensesResourceRow = page
    .getByRole("row")
    .filter({ has: page.getByText("expenses", { exact: true }) });
  await expensesResourceRow.click();
  await page
    .getByLabel("Request prefixes")
    .fill("https://expenses.seibert.localdev/api\nhttps://redirect.seibert.localdev/");
  await page.getByRole("button", { name: "Save resource" }).click();
  await expect(page).toHaveURL("https://weldall.seibert.localdev/admin/resources");

  await page.getByRole("link", { name: "Email assignments" }).click();
  await expect(page.getByRole("heading", { name: "Email assignments" })).toBeVisible();
  const aliceRow = page.getByRole("row").filter({ hasText: "alice@example.com" });
  await expect(aliceRow).toBeVisible();
  await aliceRow.click();
  await expect(page.getByRole("heading", { name: "Edit assignment" })).toBeVisible();
  await page.getByLabel("Find scopes").fill("expenses:");
  for (const scope of ["expenses:create", "expenses:delete", "expenses:read", "expenses:write"]) {
    await page.getByRole("checkbox", { name: new RegExp(`^${scope}`) }).check();
  }
  await page.getByRole("button", { name: "Save assignment" }).click();
  await expect(page).toHaveURL("https://weldall.seibert.localdev/admin/assignments");
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "alice@example.com" })
      .getByText("expenses:read", { exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Group providers" }).click();
  await expect(page.getByRole("heading", { name: "Group providers" })).toBeVisible();
  await page.getByRole("link", { name: "Group assignments" }).click();
  await expect(page.getByRole("heading", { name: "Group assignments" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("link", { name: "Create group assignment" }).click();
  await expect(page).toHaveURL("https://weldall.seibert.localdev/admin/group-assignments/new");
  await expect(page.getByRole("heading", { name: "Create group assignment" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /^weldall:login/ })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /^weldall:administer/ })).toBeVisible();
  await page.getByRole("link", { name: "Cancel" }).click();

  await page.getByRole("link", { name: "Skill registry" }).click();
  await expect(page.getByRole("heading", { name: "Skill registry" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("link", { name: "Create skill" }).click();
  await page.getByRole("textbox", { name: /^Skill ID/ }).fill("expenses.list");
  await page.getByRole("textbox", { name: /^Title/ }).fill("List expenses");
  await page.getByRole("button", { name: "Required scopes" }).click();
  await expect(page.getByRole("option", { name: /weldall:login/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /weldall:administer/ })).toBeVisible();
  await page.getByRole("option", { name: /expenses:read/ }).click();
  await page
    .getByLabel("Markdown instructions")
    .fill(
      "Load expenses with `weldall request --scope expenses:read https://expenses.seibert.localdev/api/expenses`.",
    );
  await Promise.all([
    page.waitForURL("https://weldall.seibert.localdev/admin/skills"),
    page.getByRole("button", { name: "Create skill" }).click(),
  ]);
  await page.goto("https://weldall.seibert.localdev/skills?q=expenses.list");
  const skillDirectory = page.getByRole("region", { name: "Available skills" });
  await expect(skillDirectory.getByRole("link", { name: "View List expenses" })).toHaveAttribute(
    "href",
    "/skill/expenses.list",
  );

  const scopes = await runCli("scopes");
  expect(scopes, scopes.stderr).toMatchObject({ code: 0 });
  expect(scopes.stdout.trim().split("\n").sort()).toEqual([
    "expenses:create",
    "expenses:delete",
    "expenses:read",
    "expenses:write",
    "weldall:administer",
    "weldall:login",
  ]);
  const scopesJson = await runCli("scopes", "--json");
  expect(scopesJson, scopesJson.stderr).toMatchObject({ code: 0 });
  expect(JSON.parse(scopesJson.stdout)).toEqual({
    assignedScopes: [
      "expenses:create",
      "expenses:delete",
      "expenses:read",
      "expenses:write",
      "weldall:administer",
      "weldall:login",
    ],
    resources: expect.arrayContaining([
      expect.objectContaining({
        key: "expenses",
        resourceIdentifier: "https://expenses.seibert.localdev/api",
        requestPrefixes: expect.arrayContaining(["https://expenses.seibert.localdev/api"]),
      }),
      expect.objectContaining({ key: "reports", grantedScopes: ["expenses:read"] }),
    ]),
  });

  const skills = await runCli("skills");
  expect(skills, skills.stderr).toMatchObject({ code: 0 });
  expect(skills.stdout).toContain("List expenses");
  expect(skills.stdout).toContain("ID: expenses.list");
  const skill = await runCli("skills", "show", "expenses.list");
  expect(skill, skill.stderr).toMatchObject({ code: 0 });
  expect(skill.stdout).toContain("requiredScopes:");
  expect(skill.stdout).toContain("weldall request --scope expenses:read");

  const request = await runCli(
    "request",
    "--scope",
    "expenses:read",
    "https://expenses.seibert.localdev/api/expenses?year=2026",
  );
  expect(request, request.stderr).toMatchObject({ code: 0 });
  expect(JSON.parse(request.stdout)).toMatchObject({
    expenses: [{ id: "expense-1" }],
    subject: expect.any(String),
  });
  const createdExpense = await runCli(
    "request",
    "--method",
    "POST",
    "--scope",
    "expenses:create",
    "--json",
    '{"description":"Train","amount":24}',
    "https://expenses.seibert.localdev/api/expenses",
  );
  expect(createdExpense, createdExpense.stderr).toMatchObject({ code: 0 });
  expect(JSON.parse(createdExpense.stdout)).toMatchObject({ description: "Train", amount: 24 });
  const deletedExpense = await runCli(
    "request",
    "--method",
    "DELETE",
    "--scope",
    "expenses:delete",
    "--scope",
    "expenses:write",
    "https://expenses.seibert.localdev/api/expenses/expense-1",
  );
  expect(deletedExpense, deletedExpense.stderr).toMatchObject({ code: 0 });
  expect(JSON.parse(deletedExpense.stdout)).toEqual({ deleted: "expense-1" });

  const reportsRequest = await runCli(
    "request",
    "--scope",
    "expenses:read",
    "https://reports.seibert.localdev/api/expenses",
  );
  expect(reportsRequest, reportsRequest.stderr).toMatchObject({ code: 0 });
  expect(JSON.parse(reportsRequest.stdout)).toMatchObject({ expenses: [{ id: "expense-1" }] });

  const resetCatcher = async () => {
    const response = await apiRequest.post("https://catcher.seibert.localdev/_control/reset");
    expect(response.ok()).toBe(true);
  };
  const expectNoCapturedRequests = async () => {
    const response = await apiRequest.get("https://catcher.seibert.localdev/_control/count");
    expect(response.ok()).toBe(true);
    expect(await response.json()).toEqual({ count: 0 });
  };

  await resetCatcher();
  const unknownTarget = await runCli(
    "request",
    "--scope",
    "expenses:read",
    "https://catcher.seibert.localdev/captured",
  );
  expect(unknownTarget.code).toBe(1);
  expect(unknownTarget.stderr).toContain("No registered resource accepts");
  await expectNoCapturedRequests();

  const pathBoundaryAttack = await runCli(
    "request",
    "--scope",
    "expenses:read",
    "https://expenses.seibert.localdev/api-attacker",
  );
  expect(pathBoundaryAttack.code).toBe(1);
  expect(pathBoundaryAttack.stderr).toContain("No registered resource accepts");

  await resetCatcher();
  const redirected = await runCli(
    "request",
    "--scope",
    "expenses:read",
    "https://redirect.seibert.localdev/redirect",
  );
  expect(redirected.code).toBe(1);
  expect(normalizePanelOutput(redirected.stderr)).toMatch(
    /Error (?:fetch failed|redirect count exceeded)/,
  );
  await expectNoCapturedRequests();

  await page.goto("https://weldall.seibert.localdev/admin/resources");
  const reportsRow = page.getByRole("row").filter({ hasText: "reports" });
  await reportsRow.click();
  await page.getByLabel("Enabled").click();
  await page.getByRole("button", { name: "Save resource" }).click();
  const disabledRequest = await runCli(
    "request",
    "--scope",
    "expenses:read",
    "https://reports.seibert.localdev/api/expenses",
  );
  expect(disabledRequest.code).toBe(1);
  expect(disabledRequest.stderr).toContain("No registered resource accepts");

  await page.goto("https://weldall.seibert.localdev/admin/resources");
  const disabledReportsRow = page.getByRole("row").filter({ hasText: "reports" });
  await disabledReportsRow.click();
  await expect(page.getByRole("link", { name: "View skills (0)" })).toBeVisible();
  await page.getByRole("button", { name: "Delete resource" }).click();
  const deleteResourceDialog = page.getByRole("alertdialog");
  await expect(deleteResourceDialog).toContainText("Reports");
  await deleteResourceDialog.getByRole("button", { name: "Delete resource" }).click();
  await expect(page).toHaveURL("https://weldall.seibert.localdev/admin/resources");
  await expect(page.getByRole("row").filter({ hasText: "reports" })).toHaveCount(0);

  await page.getByRole("link", { name: "CLI", exact: true }).click();
  await expect(page.getByRole("heading", { name: "CLI", exact: true })).toBeVisible();
  const appendix = "Gude! Use Weldall for everything related to Seibert.";
  await page.getByLabel("CLI appendix").fill(appendix);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("CLI settings saved", { exact: true })).toBeVisible();
  const staleHelp = await runCli();
  expect(staleHelp, staleHelp.stderr).toMatchObject({ code: 0 });
  expect(staleHelp.stdout).toContain("USAGE:");
  const refreshedHelp = await runCli("--help");
  expect(refreshedHelp, refreshedHelp.stderr).toMatchObject({ code: 0 });
  expect(refreshedHelp.stdout).toContain(appendix);
  expect(refreshedHelp.stdout).toContain("Organization instructions");

  await page.getByRole("link", { name: "Users", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const userRow = page.getByRole("row").filter({ hasText: "alice@example.com" });
  await expect(userRow).toBeVisible();
  await userRow.click();
  await expect(page.getByRole("heading", { name: "Alice E2E" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("heading", { name: "Audit activity" })).toBeVisible();
  await expect(
    page.getByText("id_jag.issued", { exact: true }).filter({ visible: true }).first(),
  ).toBeVisible();

  const logout = await runCli("logout");
  expect(logout, logout.stderr).toMatchObject({ code: 0 });
  expect(logout.stdout).toContain("Logged out.");
  const afterLogout = await runCli("scopes");
  expect(afterLogout.code).toBe(1);
  expect(afterLogout.stderr).toContain("not logged in");
});

test("denies CLI login without weldall:login while preserving browser authentication", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const login = startCli(["login"], 150_000);
  await openDevelopmentLogin(page, login);
  await expect(page.getByRole("heading", { name: "Insecure development login" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByLabel("Email").selectOption("bob@example.com");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Login to Weldall CLI" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Approve" }).click();

  const loginResult = await login.result;
  expect(loginResult.code).toBe(1);
  expect(normalizePanelOutput(loginResult.stderr)).toContain(
    "the weldall:login scope must be assigned to your account",
  );

  await page.goto("https://weldall.seibert.localdev/");
  // The skill directory moved from "/" to "/skills" and its "Skill directory"
  // heading was replaced by the "Available skills" region (see 92b4949). Assert
  // the region and allow generous time for the route to cold-compile in CI.
  await expect(page.getByRole("region", { name: "Available skills" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("link", { name: "View Analyze budget variance" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(0);

  await page.goto("https://weldall.seibert.localdev/admin/resources");
  await expect(page).toHaveURL(/\/access-denied$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Administrator access required" })).toBeVisible({
    timeout: 30_000,
  });
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
