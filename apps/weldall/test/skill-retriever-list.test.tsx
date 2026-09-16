import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SkillRetrieverList } from "../src/app/_components/skill-retriever-list";

const retrievers = [
  { id: "user-a", displayName: "Avery Analyst", avatarUrl: "/api/avatars/user-a" },
  { id: "user-b", displayName: "Bea Builder", avatarUrl: null },
];

describe("skill retriever list", () => {
  it("renders each retriever with the proxied avatar and an initials fallback", () => {
    const html = renderToStaticMarkup(<SkillRetrieverList retrievers={retrievers} />);

    expect(html).toContain('src="/api/avatars/user-a"');
    expect(html).not.toContain("/api/avatars/user-b");
    expect(html).toContain("Avery Analyst");
    expect(html).toContain("Bea Builder");
    expect(html).toContain(">BB<");
    expect(html).toContain('class="skill-retriever-list"');
    expect(html).not.toContain("skill-retriever-list-scroll");
  });

  it("caps its height when it renders inside the popover", () => {
    const html = renderToStaticMarkup(<SkillRetrieverList isScrollable retrievers={retrievers} />);

    expect(html).toContain("skill-retriever-list skill-retriever-list-scroll");
  });
});
