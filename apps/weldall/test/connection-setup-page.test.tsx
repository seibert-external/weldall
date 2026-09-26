import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../src/app/connections/setup/[id]/page";
import { ScopeChoices, SetupForm } from "../src/app/connections/setup/[id]/setup-form";
import { scopeCatalog } from "../src/server/connectors/providers/google/setup";

const mocks = vi.hoisted(() => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@tanstack/react-query", () => mocks);

const selectedScope = "https://www.googleapis.com/auth/gmail.readonly";
const attempt = {
  status: "SETUP",
  connector: { name: "Google" },
  scopes: scopeCatalog,
  selection: { scopes: [selectedScope] },
};

beforeEach(() => {
  mocks.useQuery.mockReturnValue({ isPending: false, error: null, data: attempt });
  mocks.useMutation.mockReturnValue({ isPending: false, error: null, mutate: vi.fn() });
});

describe("connection setup presentation", () => {
  it("uses the login shell and branded panel around the setup form", async () => {
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: "attempt" }) }));
    expect(html).toContain('class="login-shell"');
    expect(html).toContain('class="login-panel setup-panel"');
    expect(html).toContain('alt="Weldall"');
    expect(html.indexOf('alt="Weldall"')).toBeLessThan(html.indexOf("<form"));
    expect(html).toContain("You are about to connect an account to Google in Weldall CLI.");
    expect(html).toContain("Continue to Google");
    expect(html).toContain(
      "You can disconnect the account or change the permissions via Weldall CLI. Just ask your agent.",
    );
  });

  it("keeps named scope groups, descriptions, required scopes and saved selections", () => {
    const html = renderToStaticMarkup(
      <ScopeChoices scopes={scopeCatalog} selected={[selectedScope]} onChange={vi.fn()} />,
    );
    expect(html.match(/<fieldset/g)).toHaveLength(3);
    for (const group of ["Identity", "Gmail", "Calendar"]) expect(html).toContain(group);
    for (const scope of scopeCatalog) {
      expect(html).toContain(scope.label);
      expect(html).toContain(scope.description);
    }
    const inputs = html.match(/<input\b[^>]*>/g)!;
    expect(inputs).toHaveLength(scopeCatalog.length);
    expect(inputs.filter((input) => input.includes('disabled=""'))).toHaveLength(2);
    expect(inputs.filter((input) => input.includes('checked=""'))).toHaveLength(3);
    expect(inputs[0]).toContain('checked=""');
    expect(inputs[1]).toContain('checked=""');
    expect(inputs[2]).toContain('checked=""');
  });

  it("shows a loading message without a form", () => {
    mocks.useQuery.mockReturnValue({ isPending: true });
    const html = renderToStaticMarkup(<SetupForm id="attempt" />);
    expect(html).toContain("Loading connection setup…");
    expect(html).not.toContain("<form");
  });

  it("keeps the sign-in recovery link in an unavailable setup", () => {
    mocks.useQuery.mockReturnValue({ isPending: false, error: new Error("Session required") });
    const html = renderToStaticMarkup(<SetupForm id="attempt" />);
    expect(html).toContain("Setup unavailable");
    expect(html).toContain("Session required");
    expect(html).toContain('href="/login"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("as the initiating CLI user, then reload this page.");
    expect(html).not.toContain("<form");
  });

  it("returns completed attempts to the CLI without showing scope controls", () => {
    mocks.useQuery.mockReturnValue({ data: { ...attempt, status: "SUCCEEDED" } });
    const html = renderToStaticMarkup(<SetupForm id="attempt" />);
    expect(html).toContain("Authorization status: SUCCEEDED. Return to the CLI.");
    expect(html).not.toContain("<form");
  });

  it("keeps submission errors visible and disables the pending submit button", () => {
    mocks.useMutation.mockReturnValue({
      isPending: false,
      error: new Error("Select an API permission"),
      mutate: vi.fn(),
    });
    const html = renderToStaticMarkup(<SetupForm id="attempt" />);
    expect(html).toContain("Cannot continue");
    expect(html).toContain("Select an API permission");
    mocks.useMutation.mockReturnValue({ isPending: true, error: null, mutate: vi.fn() });
    const pending = renderToStaticMarkup(<SetupForm id="attempt" />);
    const button = pending.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0];
    expect(button).toContain('disabled=""');
  });
});
