import type { WriteStream } from "node:tty";

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

export const brandHeading = (issuer: string | null) => {
  const name = "Weldall";
  const host = `Host  ${issuer ? terminalText(issuer) : "Not configured"}`;
  const width = Math.max(name.length, host.length);
  const horizontal = "═".repeat(width + 2);
  return [
    `╔${horizontal}╗`,
    `║ ${ansi("1;38;5;33", name, process.stdout)}${" ".repeat(width - name.length)} ║`,
    `║ ${host.padEnd(width)} ║`,
    `╚${horizontal}╝`,
  ].join("\n");
};

const justifyLine = (words: string[], width: number) => {
  if (words.length < 2) return words.join("");
  const spaces = width - words.reduce((length, word) => length + word.length, 0);
  const gaps = words.length - 1;
  const gapWidth = Math.floor(spaces / gaps);
  const widerGaps = spaces % gaps;
  return words
    .map((word, index) =>
      index === gaps ? word : `${word}${" ".repeat(gapWidth + (index < widerGaps ? 1 : 0))}`,
    )
    .join("");
};

const chunks = (word: string, width: number) => {
  const values: string[] = [];
  for (let offset = 0; offset < word.length; offset += width)
    values.push(word.slice(offset, offset + width));
  return values;
};

const blockLines = (value: string, width: number) =>
  value.split("\n").flatMap((sourceLine) => {
    const words = sourceLine
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .flatMap((word) => chunks(word, width));
    if (words.length === 0) return [""];
    const lines: string[][] = [];
    for (const word of words) {
      const current = lines.at(-1);
      if (!current || current.join(" ").length + word.length + 1 > width) lines.push([word]);
      else current.push(word);
    }
    return lines.map((line, index) =>
      index === lines.length - 1 ? line.join(" ") : justifyLine(line, width),
    );
  });

export const appendixFrame = (value: string, columns = process.stdout.columns || 80) => {
  const document = terminalDocument(value).trim();
  if (!document) return "";
  const title = "Organization instructions";
  const width = Math.max(title.length + 1, Math.min(76, columns - 4));
  const lines = blockLines(document, width);
  return [
    `╔═ ${ansi("1;38;5;220", title, process.stdout)} ${"═".repeat(width - title.length - 1)}╗`,
    ...lines.map((line) => `║ ${line.padEnd(width)} ║`),
    `╚${"═".repeat(width + 2)}╝`,
  ].join("\n");
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
