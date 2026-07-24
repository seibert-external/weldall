import type { WriteStream } from "node:tty";
import { createLogUpdate } from "log-update";

const ansi = (code: string, value: string, stream: WriteStream) =>
  stream.isTTY && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb"
    ? `\u001B[${code}m${value}\u001B[0m`
    : value;

export const blue = (value: string, stream: WriteStream = process.stdout) =>
  ansi("38;5;33", value, stream);
export const yellow = (value: string, stream: WriteStream = process.stdout) =>
  ansi("38;5;220", value, stream);
export const green = (value: string, stream: WriteStream = process.stdout) =>
  ansi("38;5;41", value, stream);
export const red = (value: string, stream: WriteStream = process.stderr) =>
  ansi("38;5;196", value, stream);
export const bold = (value: string, stream: WriteStream = process.stdout) =>
  ansi("1", value, stream);
export const dim = (value: string, stream: WriteStream = process.stdout) =>
  ansi("2", value, stream);

export const terminalText = (value: string) => value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "�");
export const terminalDocument = (value: string) =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "�");

const unicodeTerminal = () => {
  const locale = process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG;
  return locale === undefined || /utf-?8/i.test(locale);
};

const lineWidth = () => {
  const columns = process.stdout.columns;
  return Math.max(1, Math.min(36, (columns && columns > 0 ? columns : 40) - 4));
};
const lineGlyph = () => (unicodeTerminal() ? "━" : "-");

const coloredLine = (highlightColumn: number) => {
  const glyphs = lineGlyph().repeat(lineWidth());
  const groups = Array.from(glyphs).reduce<Array<{ code: string; value: string }>>(
    (result, character, index) => {
      const code = Math.abs(index - highlightColumn) <= 1 ? "38;5;220" : "38;5;33";
      const current = result.at(-1);
      if (current?.code === code) current.value += character;
      else result.push({ code, value: character });
      return result;
    },
    [],
  );
  return groups.map(({ code, value }) => ansi(code, value, process.stdout)).join("");
};

export const brandLine = () => {
  if (!process.stdout.isTTY) return "";
  return coloredLine(Math.floor(lineWidth() / 2));
};

const canAnimateLine = () =>
  process.stdout.isTTY &&
  unicodeTerminal() &&
  process.env.TERM !== "dumb" &&
  !("CI" in process.env) &&
  !("NO_COLOR" in process.env) &&
  !("WELDALL_NO_ANIMATION" in process.env);

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export const animateBrandLine = async () => {
  if (!canAnimateLine()) return;

  const render = createLogUpdate(process.stdout, { showCursor: true });
  const frameCount = 12;
  try {
    for (let frame = 0; frame < frameCount; frame += 1) {
      const highlightColumn = Math.round(-2 + (frame * (lineWidth() + 3)) / (frameCount - 1));
      render(coloredLine(highlightColumn));
      await wait(55);
    }
  } finally {
    render.clear();
    render.done();
  }
};

const glyph = (unicode: string, ascii: string) =>
  process.stdout.isTTY && unicodeTerminal() ? unicode : ascii;

export const checkmark = () => green(glyph("✓", "OK"));
export const success = (message: string) => console.log(`${checkmark()} ${message}`);
export const info = (message: string) => console.log(`${blue(glyph("●", ">"))} ${message}`);
export const warning = (message: string) => console.log(`${yellow(glyph("⚠", "!"))} ${message}`);

export const printError = (message: string, hint?: string) => {
  console.error(`${red("Error:")} ${terminalText(message)}`);
  if (hint) console.error(`${dim("Hint:", process.stderr)} ${terminalText(hint)}`);
};

export const printFields = (fields: ReadonlyArray<readonly [string, string]>) => {
  const width = Math.max(...fields.map(([label]) => label.length));
  for (const [label, value] of fields) console.log(`${dim(label.padEnd(width))}  ${value}`);
};
