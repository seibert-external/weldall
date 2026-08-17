import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { spawn as spawnPty } from "@lydell/node-pty";

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

const plainTerminalOutput = (value: string) =>
  value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "").replace(/\r/g, "");

const runCliPty = async (
  args: string[],
  answer: string,
  timeoutMs = 60_000,
): Promise<CliResult> => {
  const terminal = spawnPty(process.execPath, ["--use-system-ca", cli, ...args], {
    cwd: workspace,
    env: Object.fromEntries(
      Object.entries(cliEnv)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([name, value]) => [name, value]),
    ),
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    useConpty: false,
  });
  let output = "";
  let answered = false;
  const subscription = terminal.onData((chunk) => {
    output += chunk;
    if (!answered && output.includes("Approve this browser connection?")) {
      answered = true;
      terminal.write(`${answer}\r`);
    }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      terminal.kill();
      reject(
        new Error(`PTY CLI timed out: weldall ${args.join(" ")}\n${plainTerminalOutput(output)}`),
      );
    }, timeoutMs);
    terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timer);
      subscription.dispose();
      resolve({
        code: signal ? 128 + signal : exitCode,
        stdout: plainTerminalOutput(output),
        stderr: "",
      });
    });
  });
};

async function loginAlice(page: Page): Promise<void> {
  const login = startCli(["login"], 150_000);
  await page.goto(await waitForBrowserUrl(login));
  await page.getByRole("button", { name: "Development login" }).click();
  await expect(page.getByRole("heading", { name: "Insecure development login" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByLabel("Email").selectOption("alice@example.com");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Login to Weldall CLI" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Approve" }).click();
  const result = await login.result;
  expect(result, result.stderr).toMatchObject({ code: 0 });
}

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
  test.setTimeout(360_000);

  const login = startCli(["login"], 150_000);
  await page.goto(await waitForBrowserUrl(login));
  await page.getByRole("button", { name: "Development login" }).click();
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

  await page.goto("https://weldall.seibert.localdev/scopes");
  await expect(page.getByRole("heading", { name: "Scopes" })).toBeVisible();
  await expect(page.getByText("weldall:administer", { exact: true })).toBeVisible();
  await expect(page.getByText("weldall:login", { exact: true })).toBeVisible();
  await expect(page.getByText("expenses:read", { exact: true })).toBeVisible();

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
  await expect(page).toHaveURL("https://weldall.seibert.localdev/resources");

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
  await expect(page).toHaveURL("https://weldall.seibert.localdev/assignments");
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
  await expect(page).toHaveURL("https://weldall.seibert.localdev/group-assignments/new");
  await expect(page.getByRole("heading", { name: "Create group assignment" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /^weldall:login/ })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /^weldall:administer/ })).toBeVisible();
  await page.getByRole("link", { name: "Cancel" }).click();

  await page.getByRole("link", { name: "Skill registry" }).click();
  await expect(page.getByRole("heading", { name: "Skill registry" })).toBeVisible();
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
  await page.getByRole("button", { name: "Create skill" }).click();
  await expect(page.getByRole("row").filter({ hasText: "expenses.list" })).toBeVisible();

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

  await page.goto("https://weldall.seibert.localdev/resources");
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

  await page.goto("https://weldall.seibert.localdev/resources");
  const disabledReportsRow = page.getByRole("row").filter({ hasText: "reports" });
  await disabledReportsRow.click();
  await expect(page.getByRole("link", { name: "View skills (0)" })).toBeVisible();
  await page.getByRole("button", { name: "Delete resource" }).click();
  const deleteResourceDialog = page.getByRole("alertdialog");
  await expect(deleteResourceDialog).toContainText("Reports");
  await deleteResourceDialog.getByRole("button", { name: "Delete resource" }).click();
  await expect(page).toHaveURL("https://weldall.seibert.localdev/resources");
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

test("connects a real Expenses SPA through the CLI and enforces live browser policy", async ({
  page,
  context,
}) => {
  test.setTimeout(360_000);
  await loginAlice(page);

  // Make this test independent from seed policy while preserving the existing admin UI path.
  await page.goto("https://weldall.seibert.localdev/assignments");
  const aliceRow = page.getByRole("row").filter({ hasText: "alice@example.com" });
  await expect(aliceRow).toBeVisible();
  await aliceRow.click();
  for (const scope of ["expenses:read", "expenses:create"]) {
    const checkbox = page.getByRole("checkbox", { name: new RegExp(`^${scope}`) });
    if (!(await checkbox.isChecked())) await checkbox.check();
  }
  await page.getByRole("button", { name: "Save assignment" }).click();
  await expect(page).toHaveURL("https://weldall.seibert.localdev/assignments");

  // Keep a second enabled registration for the cross-resource assertion. The
  // earlier administration test deletes its own Reports fixture.
  await page.goto("https://weldall.seibert.localdev/resources");
  await page.getByRole("link", { name: "Create resource" }).click();
  await page.getByLabel("Resource key").fill("browser-reports");
  await page.getByLabel("Name").fill("Browser reports");
  await page.getByLabel("Resource identifier").fill("https://reports.seibert.localdev/api");
  await page.getByLabel("Authorization server").fill("https://reports.seibert.localdev");
  await page.getByLabel("Downstream client ID").fill("weldall-cli-at-reports");
  await page.getByLabel("Request prefixes").fill("https://reports.seibert.localdev/api");
  await page.getByRole("button", { name: "Supported scopes" }).click();
  await page.getByRole("option", { name: "expenses:read" }).click();
  await page.getByRole("button", { name: "Create resource" }).click();
  await expect(page.getByRole("row").filter({ hasText: "browser-reports" })).toBeVisible();

  const spa = await context.newPage();
  const browserFailures: string[] = [];
  spa.on("pageerror", (error) => browserFailures.push(`pageerror:${error.message}`));
  spa.on("console", (message) => {
    if (message.type() === "error") browserFailures.push(`console:${message.text()}`);
  });
  await spa.goto("https://expenses.seibert.localdev/weldall-browser");
  await expect(spa.getByText("Supported browser", { exact: true })).toBeVisible();
  await expect(spa.locator('script[type="module"]')).toHaveAttribute(
    "src",
    "/weldall-browser/app.js",
  );

  const connect = async () => {
    await spa.getByRole("button", { name: "Start connection" }).click();
    await expect(spa.locator("#command")).toContainText("weldall connect", { timeout: 30_000 });
    const command = (await spa.locator("#command").textContent()) ?? "";
    const code = command.match(/weldall connect ([A-Z2-9]{4}-[A-Z2-9]{4})/u)?.[1];
    expect(code).toBeTruthy();
    const approval = await runCliPty(["connect", code!], "yes", 90_000);
    expect(approval, describeCliResult(approval)).toMatchObject({ code: 0 });
    expect(approval.stdout).toContain(code!);
    expect(approval.stdout).toContain("https://expenses.seibert.localdev");
    expect(approval.stdout).toContain("Expenses");
    expect(approval.stdout).toContain("Approve only if you started this connection");
    expect(approval.stdout).toContain("Approved the browser connection");
    await expect(spa.locator("#identity")).not.toHaveText("Not connected", { timeout: 45_000 });
  };

  const storedState = () =>
    spa.evaluate(async () => {
      const databaseName =
        "weldall-browser:https://weldall.seibert.localdev:https://expenses.seibert.localdev/api";
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const record = await new Promise<any>((resolve, reject) => {
          const request = database
            .transaction("state", "readonly")
            .objectStore("state")
            .get("connection");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        let privateExportRejected = false;
        try {
          await crypto.subtle.exportKey("jwk", record.privateKey);
        } catch {
          privateExportRejected = true;
        }
        return {
          connectionId: record.connectionId as string,
          refreshToken: record.refreshToken as string,
          subject: record.subject as string,
          extractable: record.privateKey.extractable as boolean,
          privateExportRejected,
          keyType: record.privateKey.type as string,
        };
      } finally {
        database.close();
      }
    });

  const directExchange = (
    targetResource = "https://expenses.seibert.localdev/api",
    audience = "https://expenses.seibert.localdev",
    scope = "expenses:read",
  ) =>
    spa.evaluate(
      async ({ targetResource, audience, scope }) => {
        const sdkUrl = "/weldall-browser/sdk/index.js";
        const sdk = await import(sdkUrl);
        const issuer = "https://weldall.seibert.localdev";
        const sourceResource = "https://expenses.seibert.localdev/api";
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(`weldall-browser:${issuer}:${sourceResource}`, 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const stored = await new Promise<any>((resolve, reject) => {
          const request = database
            .transaction("state", "readonly")
            .objectStore("state")
            .get("connection");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        database.close();
        if (!stored?.refreshToken || !stored.privateKey)
          return { blocked: true, error: "missing-local-credentials" };
        const endpoint = `${issuer}/api/auth/oauth2/token`;
        const proof = await sdk.createBrowserDpopProof({
          privateKey: stored.privateKey,
          publicJwk: stored.publicJwk,
          method: "POST",
          url: endpoint,
        });
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
              requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
              subject_token_type: "urn:ietf:params:oauth:token-type:refresh_token",
              subject_token: stored.refreshToken,
              client_id: stored.browserClientId,
              resource: targetResource,
              audience,
              scope,
            }),
            credentials: "omit",
            redirect: "error",
          });
          const body = await response.json().catch(() => null);
          return {
            blocked: !response.ok,
            status: response.status,
            error: body && typeof body.error === "string" ? body.error : null,
          };
        } catch (error) {
          return {
            blocked: true,
            error: "cors",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
      { targetResource, audience, scope },
    );

  await connect();
  const initial = await storedState();
  expect(initial).toMatchObject({
    connectionId: expect.any(String),
    subject: expect.any(String),
    extractable: false,
    privateExportRejected: true,
    keyType: "private",
  });
  await spa.reload();
  await expect(spa.getByText("Supported browser", { exact: true })).toBeVisible();
  const reloaded = await storedState();
  expect(reloaded.connectionId).toBe(initial.connectionId);
  expect(reloaded.extractable).toBe(false);
  await spa.getByRole("button", { name: "Verify remotely" }).click();
  await expect(spa.locator("#output")).toContainText('"verified": "remote"');
  const rotated = await storedState();
  expect(rotated.refreshToken).not.toBe(initial.refreshToken);

  await spa.getByRole("button", { name: "Read expenses" }).click();
  await expect(spa.locator("#output")).toContainText("expense-1");
  await spa.getByRole("button", { name: "Create expense" }).click();
  await expect(spa.locator("#output")).toContainText("Browser development expense");

  const protocolChecks = await spa.evaluate(async () => {
    const sdkUrl = "/weldall-browser/sdk/index.js";
    const sdk = await import(sdkUrl);
    const issuer = "https://weldall.seibert.localdev";
    const originResource = "https://expenses.seibert.localdev/api";
    const clientId = "weldall-browser:expenses";
    const token = `${issuer}/api/auth/oauth2/token`;
    const device = `${issuer}/api/auth/oauth2/device_authorization`;
    const databaseName = `weldall-browser:${issuer}:${originResource}`;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise<any>((resolve, reject) => {
      const request = database
        .transaction("state", "readonly")
        .objectStore("state")
        .get("connection");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const pairA = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const pairB = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwkA = await crypto.subtle.exportKey("jwk", pairA.publicKey);
    const jwkB = await crypto.subtle.exportKey("jwk", pairB.publicKey);
    const proofA = await sdk.createBrowserDpopProof({
      privateKey: pairA.privateKey,
      publicJwk: jwkA,
      method: "POST",
      url: device,
    });
    const startBody = new URLSearchParams({ client_id: clientId, resource: originResource });
    const started = await fetch(device, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: proofA },
      body: startBody,
      credentials: "omit",
    });
    const startedJson = await started.json();
    const replay = await fetch(device, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: proofA },
      body: startBody,
      credentials: "omit",
    });
    const wrongResourceProof = await sdk.createBrowserDpopProof({
      privateKey: pairA.privateKey,
      publicJwk: jwkA,
      method: "POST",
      url: device,
    });
    const wrongResource = await fetch(device, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        dpop: wrongResourceProof,
      },
      body: new URLSearchParams({
        client_id: clientId,
        resource: "https://reports.seibert.localdev/api",
      }),
      credentials: "omit",
    });
    const wrongKeyProof = await sdk.createBrowserDpopProof({
      privateKey: pairB.privateKey,
      publicJwk: jwkB,
      method: "POST",
      url: token,
    });
    const wrongKey = await fetch(token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: wrongKeyProof },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: startedJson.device_code,
      }),
      credentials: "omit",
    });
    const crossResourceProof = await sdk.createBrowserDpopProof({
      privateKey: stored.privateKey,
      publicJwk: stored.publicJwk,
      method: "POST",
      url: token,
    });
    const crossResource = await fetch(token, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        dpop: crossResourceProof,
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
        subject_token_type: "urn:ietf:params:oauth:token-type:refresh_token",
        subject_token: stored.refreshToken,
        client_id: clientId,
        resource: "https://reports.seibert.localdev/api",
        audience: "https://reports.seibert.localdev",
        scope: "expenses:read",
      }),
      credentials: "omit",
    });
    const crossResourceBody = await crossResource.json();

    const exchangeProof = await sdk.createBrowserDpopProof({
      privateKey: stored.privateKey,
      publicJwk: stored.publicJwk,
      method: "POST",
      url: token,
    });
    const exchange = await fetch(token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: exchangeProof },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
        subject_token_type: "urn:ietf:params:oauth:token-type:refresh_token",
        subject_token: stored.refreshToken,
        client_id: clientId,
        resource: originResource,
        audience: "https://expenses.seibert.localdev",
        scope: "expenses:read",
      }),
      credentials: "omit",
    });
    const assertion = (await exchange.json()).access_token as string;
    const downstreamTokenUrl = "https://expenses.seibert.localdev/oauth/token";
    const downstreamProof = await sdk.createBrowserDpopProof({
      privateKey: stored.privateKey,
      publicJwk: stored.publicJwk,
      method: "POST",
      url: downstreamTokenUrl,
    });
    const downstream = await fetch(downstreamTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: downstreamProof },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-dpop",
        assertion,
      }),
      credentials: "omit",
    });
    const downstreamAccess = (await downstream.json()).access_token as string;
    const apiUrl = "https://expenses.seibert.localdev/api/expenses";
    const apiProof = await sdk.createBrowserDpopProof({
      privateKey: stored.privateKey,
      publicJwk: stored.publicJwk,
      method: "GET",
      url: apiUrl,
      accessToken: downstreamAccess,
    });
    const apiInit = {
      headers: { authorization: `DPoP ${downstreamAccess}`, dpop: apiProof },
      credentials: "omit" as const,
    };
    const firstApi = await fetch(apiUrl, apiInit);
    const replayedApi = await fetch(apiUrl, apiInit);
    return {
      start: started.status,
      replay: replay.status,
      wrongResource: wrongResource.status,
      wrongKey: wrongKey.status,
      crossResource: crossResource.status,
      crossResourceError: crossResourceBody.error,
      exchange: exchange.status,
      downstream: downstream.status,
      firstApi: firstApi.status,
      replayedApi: replayedApi.status,
    };
  });
  expect(protocolChecks).toEqual({
    start: 200,
    replay: 400,
    wrongResource: 400,
    wrongKey: 400,
    crossResource: 400,
    crossResourceError: "invalid_target",
    exchange: 200,
    downstream: 200,
    firstApi: 200,
    replayedApi: 401,
  });

  const foreignOrigin = await context.newPage();
  await foreignOrigin.goto("https://catcher.seibert.localdev/health");
  await expect(
    foreignOrigin.evaluate(async () => {
      const endpoint = "https://weldall.seibert.localdev/api/auth/oauth2/device_authorization";
      const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const base64url = (bytes: Uint8Array) => {
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      };
      const encoded = (value: unknown) =>
        base64url(new TextEncoder().encode(JSON.stringify(value)));
      const header = encoded({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk });
      const payload = encoded({
        htu: endpoint,
        htm: "POST",
        iat: Math.floor(Date.now() / 1_000),
        jti: crypto.randomUUID(),
      });
      const input = `${header}.${payload}`;
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          new TextEncoder().encode(input),
        ),
      );
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            dpop: `${input}.${base64url(signature)}`,
          },
          body: new URLSearchParams({
            client_id: "weldall-browser:expenses",
            resource: "https://expenses.seibert.localdev/api",
          }),
          credentials: "omit",
          redirect: "error",
        });
        const body = await response.text();
        return {
          blocked: false,
          status: response.status,
          exposedPending: /device_code|user_code|weldall connect/iu.test(body),
        };
      } catch {
        return {
          blocked: true,
          exposedPending: /weldall connect|[A-Z2-9]{4}-[A-Z2-9]{4}/u.test(
            document.body.textContent ?? "",
          ),
        };
      }
    }),
  ).resolves.toEqual({ blocked: true, exposedPending: false });
  await foreignOrigin.close();

  // Removing a business scope blocks the next just-in-time assertion without revoking the connection.
  await page.goto("https://weldall.seibert.localdev/assignments");
  await page.getByRole("row").filter({ hasText: "alice@example.com" }).click();
  await page.getByRole("checkbox", { name: /^expenses:read/ }).uncheck();
  await page.getByRole("button", { name: "Save assignment" }).click();
  await expect(page).toHaveURL("https://weldall.seibert.localdev/assignments");
  await expect(directExchange()).resolves.toEqual({
    blocked: true,
    status: 400,
    error: "invalid_scope",
  });
  await spa.getByRole("button", { name: "Read expenses" }).click();
  await expect(spa.locator("#output")).toContainText("permission-denied");
  await page.goto("https://weldall.seibert.localdev/assignments");
  await page.getByRole("row").filter({ hasText: "alice@example.com" }).click();
  await page.getByRole("checkbox", { name: /^expenses:read/ }).check();
  await page.getByRole("button", { name: "Save assignment" }).click();
  await expect(page).toHaveURL("https://weldall.seibert.localdev/assignments");

  await spa.getByRole("button", { name: "Disconnect remotely" }).click();
  await expect(spa.locator("#output")).toContainText('"state": "disconnected"');

  // Origin removal atomically revokes its family even if the origin is restored later.
  await connect();
  await page.goto("https://weldall.seibert.localdev/resources");
  await page
    .getByRole("row")
    .filter({ has: page.getByText("expenses", { exact: true }) })
    .click();
  await page.getByLabel("Authorization server").fill("https://changed-origin.seibert.localdev");
  await page.getByLabel("Request prefixes").fill("https://changed-origin.seibert.localdev/api");
  await page.getByRole("button", { name: "Save resource" }).click();
  const removedOriginCorsStart = browserFailures.length;
  await expect(directExchange()).resolves.toMatchObject({ blocked: true, error: "cors" });
  await spa.getByRole("button", { name: "Verify remotely" }).click();
  await expect(spa.locator("#output")).toContainText('"reason": "origin-changed"');
  expect(
    browserFailures
      .slice(removedOriginCorsStart)
      .every((failure) =>
        /cors|access-control-allow-origin|blocked by access control|failed to fetch/iu.test(
          failure,
        ),
      ),
  ).toBe(true);
  await page
    .getByRole("row")
    .filter({ has: page.getByText("expenses", { exact: true }) })
    .click();
  await page.getByLabel("Authorization server").fill("https://expenses.seibert.localdev");
  await page.getByLabel("Request prefixes").fill("https://expenses.seibert.localdev/api");
  await page.getByRole("button", { name: "Save resource" }).click();
  await expect(directExchange()).resolves.toEqual({
    blocked: true,
    status: 400,
    error: "invalid_grant",
  });
  await spa.getByRole("button", { name: "Verify remotely" }).click();
  await expect(spa.locator("#output")).toContainText('"reason": "revoked"');
  await spa.getByRole("button", { name: "Clear local credentials" }).click();

  expect(
    browserFailures.filter(
      (failure) =>
        !/cors|access-control-allow-origin|blocked by access control|failed to fetch/iu.test(
          failure,
        ),
    ),
  ).toEqual([]);

  // Resource disablement blocks refresh and requires a fresh approval after re-enable.
  await connect();
  await page.goto("https://weldall.seibert.localdev/resources");
  await page
    .getByRole("row")
    .filter({ has: page.getByText("expenses", { exact: true }) })
    .click();
  await page.getByLabel("Enabled").click();
  await page.getByRole("button", { name: "Save resource" }).click();
  await expect(directExchange()).resolves.toMatchObject({ blocked: true, error: "cors" });
  const expectedCorsFailureStart = browserFailures.length;
  await spa.getByRole("button", { name: "Verify remotely" }).click();
  await expect(spa.locator("#output")).toContainText('"reason": "origin-changed"');
  expect(
    browserFailures
      .slice(expectedCorsFailureStart)
      .every((failure) =>
        /cors|access-control-allow-origin|blocked by access control|failed to fetch/iu.test(
          failure,
        ),
      ),
  ).toBe(true);
  await page.goto("https://weldall.seibert.localdev/resources");
  await page
    .getByRole("row")
    .filter({ has: page.getByText("expenses", { exact: true }) })
    .click();
  await page.getByLabel("Enabled").click();
  await page.getByRole("button", { name: "Save resource" }).click();
  await expect(directExchange()).resolves.toEqual({
    blocked: true,
    status: 400,
    error: "invalid_grant",
  });
  await spa.getByRole("button", { name: "Verify remotely" }).click();
  await expect(spa.locator("#output")).toContainText('"reason": "revoked"');
  await spa.getByRole("button", { name: "Clear local credentials" }).click();

  // The administration view can revoke an individual family and renders its audit event clearly.
  await connect();
  await page.goto("https://weldall.seibert.localdev/users");
  await page.getByRole("row").filter({ hasText: "alice@example.com" }).click();
  await expect(page.getByRole("heading", { name: "Connected browsers" })).toBeVisible();
  const activeConnection = page
    .getByRole("row")
    .filter({ hasText: "https://expenses.seibert.localdev" })
    .filter({ hasText: "Active" })
    .last();
  await activeConnection.getByRole("button", { name: "Revoke connection" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Revoke browser connections" })
    .click();
  await expect(page.getByText("Browser connection revoked", { exact: true })).toBeVisible();
  await expect(directExchange()).resolves.toEqual({
    blocked: true,
    status: 400,
    error: "invalid_grant",
  });
  await spa.getByRole("button", { name: "Verify remotely" }).click();
  await expect(spa.locator("#output")).toContainText('"reason": "revoked"');
  await expect(
    page.getByText("Browser connection revoked", { exact: true }).filter({ visible: true }).last(),
  ).toBeVisible();

  expect(
    browserFailures.filter(
      (failure) =>
        !/cors|access-control-allow-origin|blocked by access control|failed to fetch/iu.test(
          failure,
        ),
    ),
  ).toEqual([]);

  await page.goto("https://weldall.seibert.localdev/resources");
  const browserReportsRow = page.getByRole("row").filter({ hasText: "browser-reports" });
  await browserReportsRow.click();
  await page.getByRole("button", { name: "Delete resource" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete resource" }).click();
  await expect(browserReportsRow).toHaveCount(0);
  await spa.close();
});

test("denies CLI login without weldall:login while preserving browser authentication", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const login = startCli(["login"], 150_000);
  await page.goto(await waitForBrowserUrl(login));
  await page.getByRole("button", { name: "Development login" }).click();
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
  await expect(
    page.getByRole("heading", {
      name: "Weldall allows you to access your company’s services through your agent. Copy the prompt below and send it to your agent to get started.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy Prompt" })).toBeVisible();
  await page.getByRole("link", { name: "I’m an admin, let me in" }).click();
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
