import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../src/app/connections/setup/[id]/page";
import { ScopeChoices, SetupForm } from "../src/app/connections/setup/[id]/setup-form";
import type { ScopeDescriptor } from "../src/server/connectors/display";

const mocks = vi.hoisted(() => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@tanstack/react-query", () => mocks);

const selectedScope = "mail:read";
const scopeCatalog: ScopeDescriptor[] = [
  {
    id: "identity",
    label: "Identify account",
    description: "Verify the account.",
    group: "Identity",
    required: true,
  },
  {
    id: "email",
    label: "Account email",
    description: "Display the account email.",
    group: "Identity",
    required: true,
  },
  {
    id: selectedScope,
    label: "Read mail",
    description: "Read provider messages.",
    group: "Mail",
    required: false,
  },
  {
    id: "calendar:read",
    label: "Read calendars",
    description: "Read provider events.",
    group: "Calendar",
    required: false,
  },
];
const attempt = {
  status: "SETUP",
  connector: { name: "Example service" },
  scopes: scopeCatalog,
  selection: { scopes: [selectedScope] },
};

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.clearAllMocks();
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
    expect(html).toContain(
      "You are about to connect an account to Example service in Weldall CLI.",
    );
    expect(html).toContain("Continue to provider");
    expect(html).not.toContain("Google");
    expect(html).toContain(
      "You can disconnect the account or change the permissions via Weldall CLI. Just ask your agent.",
    );
  });

  it("keeps named scope groups, descriptions, required scopes and saved selections", () => {
    const html = renderToStaticMarkup(
      <ScopeChoices scopes={scopeCatalog} selected={[selectedScope]} onChange={vi.fn()} />,
    );
    expect(html.match(/<fieldset/g)).toHaveLength(3);
    for (const group of ["Identity", "Mail", "Calendar"]) expect(html).toContain(group);
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

  it("renders provider-owned single choices without interpreting their keys", () => {
    mocks.useQuery.mockReturnValue({
      isPending: false,
      data: {
        ...attempt,
        selection: { ...attempt.selection, target: "second" },
        choices: [
          {
            key: "target",
            label: "Target",
            description: "Choose a target",
            options: [
              { value: "first", label: "First" },
              { value: "second", label: "Second" },
            ],
          },
        ],
      },
    });
    const html = renderToStaticMarkup(<SetupForm id="attempt" />);
    expect(html).toContain("Choose a target");
    expect(html).toContain('value="second" selected=""');
    expect(html).toContain('value="first"');
  });
  it("preserves opaque provider selection fields when submitting scopes", async () => {
    mocks.useQuery.mockReturnValue({
      isPending: false,
      data: { ...attempt, selection: { ...attempt.selection, target: "second" } },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ url: "https://provider.example.com/authorize" }));
    const assign = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("window", { location: { assign } });
    renderToStaticMarkup(<SetupForm id="attempt" />);
    await mocks.useMutation.mock.calls[0]![0].mutationFn();
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
      selection: { scopes: [selectedScope], target: "second" },
    });
    expect(assign).toHaveBeenCalledWith("https://provider.example.com/authorize");
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
