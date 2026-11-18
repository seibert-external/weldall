import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const buttons = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@astryxdesign/core/Button", () => ({
  Button: ({ label, onClick }: { label: string; onClick: () => void }) => {
    buttons.set(label, onClick);
    return null;
  },
}));

const callback = "http://127.0.0.1:49674/callback?code=c&state=s&iss=https%3A%2F%2Fweldall.test";

// Renders the options with the real better-auth client, clicks a button and returns every
// navigation the page started.
const decide = async (label: "Approve" | "Deny", response: Response) => {
  const navigations: string[] = [];
  const location = {
    origin: "https://weldall.test",
    search: "?client_id=weldall-cli&sig=s",
    set href(url: string) {
      navigations.push(url);
    },
    assign: (url: string) => navigations.push(url),
  };
  const fetcher = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("window", { location, addEventListener: () => {} });
  vi.stubGlobal("fetch", fetcher);
  vi.resetModules();
  const { ConsentOptions } = await import("../src/app/consent/consent-options");
  renderToStaticMarkup(<ConsentOptions />);
  await buttons.get(label)!();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { navigations, body: JSON.parse(fetcher.mock.calls[0]![1].body) };
};

describe("CLI consent options", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    buttons.clear();
  });

  it.each([
    ["Approve", true, callback],
    ["Deny", false, `${callback}&error=access_denied`],
  ] as const)("navigates once to the redirect after %s", async (label, accept, url) => {
    const { navigations, body } = await decide(label, Response.json({ redirect: true, url }));
    expect(body).toMatchObject({ accept });
    expect(navigations).toEqual([url]);
  });

  it("does not navigate when consent fails", async () => {
    const { navigations } = await decide(
      "Approve",
      Response.json({ message: "missing oauth query" }, { status: 400 }),
    );
    expect(navigations).toEqual([]);
  });
});
