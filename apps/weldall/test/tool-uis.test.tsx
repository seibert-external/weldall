import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WeldallRequestToolUI } from "../src/components/assistant-ui/elements/tool-uis";

const complete = { type: "complete" as const };
const resource = { key: "personio", name: "Personio" };
const url = "https://gateway.example/personio/employees";

describe("weldallRequest tool UI", () => {
  it("renders a readable message for structured field errors", () => {
    const html = renderToStaticMarkup(
      <WeldallRequestToolUI
        args={{ skillSlug: "personio", url, method: "GET", scopes: ["personio:read"] }}
        result={{
          resource,
          url,
          method: "GET",
          status: 400,
          ok: false,
          data: {
            errors: [{ field: "sort", message: "Invalid option: expected one of asc|desc" }],
          },
          responseBytes: 64,
        }}
        status={complete}
      />,
    );

    expect(html).toContain("sort: Invalid option: expected one of asc|desc");
    expect(html).toContain("400");
  });

  it("renders OAuth-style error descriptions", () => {
    const html = renderToStaticMarkup(
      <WeldallRequestToolUI
        args={{ skillSlug: "personio", url, method: "POST", scopes: ["personio:write"] }}
        result={{
          resource,
          url,
          method: "POST",
          status: 403,
          ok: false,
          data: { error: "insufficient_scope", error_description: "scope not granted" },
          responseBytes: 40,
        }}
        status={complete}
      />,
    );

    expect(html).toContain("scope not granted");
  });

  it("renders a visible generic banner for unrecognized error bodies", () => {
    const html = renderToStaticMarkup(
      <WeldallRequestToolUI
        args={{ skillSlug: "personio", url, method: "GET", scopes: ["personio:read"] }}
        result={{
          resource,
          url,
          method: "GET",
          status: 400,
          ok: false,
          data: { code: "E_VALIDATION", invalid: ["sort"] },
          responseBytes: 48,
        }}
        status={complete}
      />,
    );

    expect(html).toContain("{&quot;code&quot;:&quot;E_VALIDATION&quot;,&quot;invalid&quot;:[&quot;sort&quot;]}");
    expect(html).toContain("text-destructive");
  });

  it("renders the payload for successful requests without an error banner", () => {
    const html = renderToStaticMarkup(
      <WeldallRequestToolUI
        args={{ skillSlug: "personio", url, method: "GET", scopes: ["personio:read"] }}
        result={{
          resource,
          url,
          method: "GET",
          status: 200,
          ok: true,
          data: { employees: [{ id: 1 }] },
          responseBytes: 20,
        }}
        status={complete}
      />,
    );

    expect(html).toContain("Personio · 200 ok");
    expect(html).toContain("200");
    expect(html).not.toContain("text-destructive");
  });
});
