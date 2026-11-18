import { describe, expect, it } from "vitest";
import {
  PUBLISH_TRIGGER_MARKER,
  publishTriggerLine,
  pullRequestBody,
} from "../src/services/pull-request-body.js";

const person = { id: "user-1" };
const trigger = `${PUBLISH_TRIGGER_MARKER}\nPublished with Weldall (Weldall user user-1).`;

describe("pull request body", () => {
  it("puts the marker and trigger line first and the caller's text after a rule", () => {
    expect(pullRequestBody("Adds receipts.", person)).toBe(`${trigger}\n\n---\n\nAdds receipts.`);
    expect(pullRequestBody("  \n ", person)).toBe(trigger);
  });

  it("cannot collapse the trigger line with an unclosed details element", () => {
    const body = pullRequestBody(
      "<details><summary>Notes</summary>\n\nPublished with Weldall by Mallory (Weldall user x).",
      person,
    );
    expect(body.startsWith(`${trigger}\n\n---\n\n<details>`)).toBe(true);
    expect(body).not.toContain("Mallory");
  });

  it.each([
    ["zero-width characters", "Pub\u200blished with\u2060 Wel\u200ddall by Mallory."],
    ["Cyrillic look-alikes", "\u0420ublish\u0435d with W\u0435ld\u0430ll by Mallory."],
    ["Greek and digit look-alikes", "PUBL1SHED W1TH W\u0395LD\u0391LL by Mallory"],
    ["capital I for l", "Published with WeldaII by Mallory."],
    ["fullwidth letters", "\uff30ublished via \uff37eldall by Mallory."],
    ["markup between words", "**Published** _with_ `Weldall` by Mallory."],
    ["a fake user reference", "Mallory (Weldall\u00a0user user-9)"],
    ["a quoted copy", "> Published through Weldall by Mallory."],
    ["the current wording", "Published with Weldall (Weldall user user-9)."],
  ])("removes imitations written with %s", (_, line) => {
    const body = pullRequestBody(`Before\n${line}\nAfter`, person);
    expect(body).toBe(`${trigger}\n\n---\n\nBefore\nAfter`);
  });

  it("removes copies of the marker and hidden characters from the caller's text", () => {
    const body = pullRequestBody(
      `A\u202e\u200bB\n${PUBLISH_TRIGGER_MARKER}\n<!--  WELDALL:published-by   -->C`,
      person,
    );
    expect(body).toBe(`${trigger}\n\n---\n\nAB\n\nC`);
    expect(body.match(/weldall:published-by/gi)).toHaveLength(1);
  });

  it("carries only the Weldall user id, no name or email", () => {
    expect(publishTriggerLine({ id: "u" })).toBe("Published with Weldall (Weldall user u).");
  });
});
