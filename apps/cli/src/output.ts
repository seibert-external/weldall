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

export const brandHeading = (columns = process.stdout.columns || 80) => {
  const name = "Weldall";
  const padding = " ".repeat(Math.max(0, Math.floor((columns - name.length) / 2)));
  return `${padding}${ansi("1;38;5;33", name, process.stdout)}`;
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
