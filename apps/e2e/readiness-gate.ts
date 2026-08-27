/**
 * E2E readiness gate (Playwright globalSetup).
 *
 * The `e2e` container shares the weldall network namespace, so this module asks
 * the same question the tests ask, over the same path: does
 * `https://<service>.seibert.localdev` resolve through the Caddy network aliases,
 * verify against the Caddy root CA, and serve the route the suite is about to
 * assert on? Compose healthchecks only prove each process answers on
 * `127.0.0.1` inside its own container, which is why an environment that is not
 * reachable on its public base URL used to surface minutes later as
 * `Unable to reach https://weldall.seibert.localdev`, `net::ERR_ABORTED`, or
 * `element(s) not found`.
 *
 * Every wait here is bounded and polls real readiness; nothing sleeps on elapsed
 * time. A dependency that never serves fails the run before the first test with
 * the dependency, the URL, and the classified error named.
 */
import { chromium, request, type APIRequestContext, type Response } from "@playwright/test";

const READINESS_DEADLINE_MS = 180_000;
const PROBE_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 500;

/** Public base URL the suite navigates to, and the endpoint that proves it serves. */
type Dependency = {
  name: string;
  url: string;
  /** Substring a correctly configured response must contain. */
  contains?: string;
};

const dependencies: Dependency[] = [
  {
    name: "weldall authorization server",
    url: "https://weldall.seibert.localdev/.well-known/oauth-authorization-server",
    contains: "https://weldall.seibert.localdev",
  },
  {
    name: "weldall protected-resource metadata",
    url: "https://weldall.seibert.localdev/.well-known/oauth-protected-resource/api",
  },
  {
    name: "weldall dev login route",
    url: "https://weldall.seibert.localdev/login",
    // ENABLE_DEV_LOGIN must reach the runtime; otherwise the suite's very first
    // click target never renders.
    contains: "Development login",
  },
  {
    name: "expenses resource server",
    url: "https://expenses.seibert.localdev/.well-known/oauth-authorization-server",
    contains: "urn:ietf:params:oauth:grant-type:jwt-dpop",
  },
  {
    name: "reports resource server",
    url: "https://reports.seibert.localdev/.well-known/oauth-authorization-server",
  },
  {
    name: "development identity provider",
    url: "https://dev-idp.seibert.localdev/.well-known/openid-configuration",
    contains: "https://dev-idp.seibert.localdev",
  },
  {
    name: "request catcher",
    url: "https://catcher.seibert.localdev/health",
    contains: '"ok":true',
  },
  {
    name: "caddy redirect site",
    url: "https://redirect.seibert.localdev/redirect",
    // The suite asserts the CLI refuses this redirect; follow it and prove it lands
    // on the catcher rather than failing as an unexplained aborted navigation.
    contains: '"captured":true',
  },
];

/**
 * Routes the suite navigates to. A cold first request to any of these used to be
 * the slowest moment in the run; warming them here means the first Playwright
 * navigation is never the first time the server has rendered the route, and a
 * route that cannot serve at all is reported as the route, not as a missing UI
 * element inside a later test.
 */
const weldallRoutes = [
  "/access-denied",
  "/admin/assignments",
  "/admin/audit",
  "/admin/cli",
  "/admin/group-assignments",
  "/admin/group-assignments/new",
  "/admin/group-providers",
  "/admin/machines",
  "/admin/resources",
  "/admin/scopes",
  "/admin/skills",
  "/admin/skills/new",
  "/admin/users",
  "/consent",
  "/install.md",
  "/skill/demo.finance.budget-variance",
  "/skills",
  "/api/me/cli",
  "/api/me/grants",
  "/api/me/scopes",
  "/api/me/skills",
];

const classifyFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|nodename nor servname/i.test(message)) {
    return `DNS failure - the hostname does not resolve through the Caddy network aliases (${message})`;
  }
  if (/self[- ]signed|unable to verify|certificate|CERT_/i.test(message)) {
    return `TLS failure - the Caddy root CA is not trusted by this process; NODE_EXTRA_CA_CERTS must point at /trust/root.crt (${message})`;
  }
  if (/ECONNREFUSED/i.test(message)) {
    return `no TLS listener for this hostname - the Caddy network alias is missing or Caddy is not publishing 443 (${message})`;
  }
  if (/ECONNRESET|socket hang up|ETIMEDOUT|aborted/i.test(message)) {
    return `connectivity failure - Caddy accepted the connection but its upstream container did not answer (${message})`;
  }
  return message;
};

const waitForDependency = async (context: APIRequestContext, dependency: Dependency) => {
  const deadline = Date.now() + READINESS_DEADLINE_MS;
  let lastProblem = "no response received yet";
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    try {
      const response = await context.get(dependency.url, {
        timeout: PROBE_TIMEOUT_MS,
        failOnStatusCode: false,
      });
      const status = response.status();
      const ok = response.ok();
      const body = await response.text().catch(() => "");
      await response.dispose();
      if (ok && (!dependency.contains || body.includes(dependency.contains))) {
        return Date.now() - startedAt;
      }
      lastProblem = dependency.contains
        ? `served HTTP ${status} without the expected marker "${dependency.contains}"`
        : `served HTTP ${status}`;
    } catch (error) {
      lastProblem = classifyFailure(error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `${dependency.name} never became reachable at ${dependency.url} within ` +
      `${READINESS_DEADLINE_MS / 1000}s. Last problem: ${lastProblem}`,
  );
};

const assertBrowserTrustsCaddyRoot = async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    for (const origin of [
      "https://weldall.seibert.localdev/",
      "https://expenses.seibert.localdev/.well-known/oauth-authorization-server",
    ]) {
      let response: Response | null = null;
      try {
        response = await page.goto(origin, {
          timeout: PROBE_TIMEOUT_MS,
          waitUntil: "domcontentloaded",
        });
      } catch (error) {
        problems.push(
          `${origin}: Chromium could not load the URL (${classifyFailure(error)}). ` +
            "The Chromium NSS trust store in the e2e image must contain the Caddy root CA.",
        );
        continue;
      }
      if (!response || !response.ok()) {
        problems.push(`${origin}: served HTTP ${response?.status() ?? "null"}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`browser TLS/navigation gate failed:\n  - ${problems.join("\n  - ")}`);
    }
  } finally {
    await browser.close();
  }
};

const warmWeldallRoutes = async (context: APIRequestContext) => {
  const slow: string[] = [];
  const problems: string[] = [];
  const results = await Promise.all(
    weldallRoutes.map(async (path) => {
      const startedAt = Date.now();
      try {
        const response = await context.get(`https://weldall.seibert.localdev${path}`, {
          timeout: PROBE_TIMEOUT_MS,
          failOnStatusCode: false,
        });
        const status = response.status();
        await response.dispose();
        return { path, status, durationMs: Date.now() - startedAt };
      } catch (error) {
        return {
          path,
          status: 0,
          durationMs: Date.now() - startedAt,
          error: classifyFailure(error),
        };
      }
    }),
  );
  for (const result of results) {
    if (result.error) {
      problems.push(`${result.path}: ${result.error}`);
    } else if (result.status >= 500) {
      problems.push(`${result.path}: served HTTP ${result.status}`);
    } else if (result.status === 404) {
      // The suite navigates these paths directly; a missing route must not be
      // discovered later as an empty page or a detached frame.
      problems.push(`${result.path}: served HTTP 404 - route is not registered`);
    }
    if (result.durationMs > 2_000) slow.push(`${result.path} (${result.durationMs}ms)`);
  }
  if (problems.length > 0) {
    throw new Error(
      `weldall routes the suite depends on are not serving:\n  - ${problems.join("\n  - ")}`,
    );
  }
  if (slow.length > 0) {
    console.log(
      `[e2e gate] warning: weldall served these routes slowly on this runner: ${slow.join(", ")}. ` +
        "The suite must run against the production build; a lazily compiling dev server " +
        "turns every first navigation into a 30s+ assertion timeout.",
    );
  }
};

export default async function readinessGate(): Promise<void> {
  const startedAt = Date.now();
  const context = await request.newContext({ timeout: PROBE_TIMEOUT_MS });
  try {
    const timings = await Promise.all(
      dependencies.map(async (dependency) => ({
        name: dependency.name,
        durationMs: await waitForDependency(context, dependency),
      })),
    );
    await assertBrowserTrustsCaddyRoot();
    await warmWeldallRoutes(context);
    const summary = timings.map((timing) => `${timing.name} ${timing.durationMs}ms`).join(", ");
    console.log(
      `[e2e gate] all ${dependencies.length} public dependencies ready + ${weldallRoutes.length} ` +
        `weldall routes warm in ${Date.now() - startedAt}ms (${summary})`,
    );
  } finally {
    await context.dispose();
  }
}
