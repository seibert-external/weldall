import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrimitiveSearchSource } from "../src/app/_components/directory-primitive-search";

afterEach(() => vi.unstubAllGlobals());

describe("directory primitive client search", () => {
  it("downloads once on bootstrap and filters the cached index in the client", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json([
        {
          type: "skill",
          id: "expenses.review",
          label: "Review expenses",
          description: "Review submitted claims",
          keywords: ["finance", "expenses:read"],
          available: true,
        },
        {
          type: "scope",
          id: "expenses:read",
          label: "expenses:read",
          description: "Read expenses",
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const errors: Array<string | null> = [];
    const source = createPrimitiveSearchSource((message) => errors.push(message));

    expect(fetchMock).not.toHaveBeenCalled();

    const bootstrap = await source.bootstrap();
    const results = await source.search("finance read");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(bootstrap.map((item) => item.auxiliaryData.group)).toEqual(["Skills", "Scopes"]);
    expect(results.map((item) => item.id)).toEqual(["skill:expenses.review"]);
    expect(source.get("skill:expenses.review")?.auxiliaryData.href).toBe("/skill/expenses.review");
    expect(errors).toEqual([null]);
  });

  it("allows a later open to retry a failed download", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal("fetch", fetchMock);
    const errors: Array<string | null> = [];
    const source = createPrimitiveSearchSource((message) => errors.push(message));

    await expect(source.bootstrap()).resolves.toEqual([]);
    await expect(source.bootstrap()).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errors).toEqual(["Search is temporarily unavailable", null]);
  });
});
