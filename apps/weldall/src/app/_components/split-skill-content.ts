export type SkillContentParts = {
  /** Text before the first heading, shown directly under the page title. */
  intro: string;
  /** Everything from the first heading on (e.g. "## Expected result"). */
  rest: string;
};

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^#{1,6}\s/;
const TITLE = /^#\s/;

/**
 * Splits skill markdown for the detail page. A leading `# Title` line is
 * dropped because the page already renders the title; lines inside fenced
 * code blocks never count as headings.
 */
export function splitSkillContent(content: string): SkillContentParts {
  const lines = content.split(/\r?\n/);
  let start = lines.findIndex((line) => line.trim() !== "");
  if (start === -1) return { intro: "", rest: "" };
  if (TITLE.test(lines[start]!)) start += 1;

  let inFence = false;
  let split = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence && HEADING.test(line)) {
      split = index;
      break;
    }
  }

  return {
    intro: lines.slice(start, split).join("\n").trim(),
    rest: lines.slice(split).join("\n").trim(),
  };
}
