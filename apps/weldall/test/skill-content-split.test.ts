import { describe, expect, it } from "vitest";
import { splitSkillContent } from "../src/app/_components/split-skill-content";

describe("splitSkillContent", () => {
  it("drops the title and splits the intro from the first section", () => {
    const content = [
      "# Analyze budget variance",
      "",
      "Use this skill to compare spending.",
      "",
      "## Expected result",
      "",
      "Return a concise result.",
    ].join("\n");

    expect(splitSkillContent(content)).toEqual({
      intro: "Use this skill to compare spending.",
      rest: "## Expected result\n\nReturn a concise result.",
    });
  });

  it("keeps everything when there is no leading title", () => {
    expect(splitSkillContent("Intro text.\n\n## Steps\n\nDo it.")).toEqual({
      intro: "Intro text.",
      rest: "## Steps\n\nDo it.",
    });
  });

  it("ignores headings inside fenced code blocks", () => {
    const content = "# Title\n\nIntro.\n\n```sh\n# not a heading\n```\n\n## Real\n\nBody.";

    expect(splitSkillContent(content)).toEqual({
      intro: "Intro.\n\n```sh\n# not a heading\n```",
      rest: "## Real\n\nBody.",
    });
  });

  it("returns only an intro when there are no further headings", () => {
    expect(splitSkillContent("# Title\n\nJust an intro.")).toEqual({
      intro: "Just an intro.",
      rest: "",
    });
  });

  it("returns only the rest when a heading follows the title directly", () => {
    expect(splitSkillContent("# Title\n## Section\nBody.")).toEqual({
      intro: "",
      rest: "## Section\nBody.",
    });
  });
});
