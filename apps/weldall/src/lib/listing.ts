/** Words as a sentence lists them: "a", "a and b", "a, b and c". */
export const listing = (words: readonly string[]): string =>
  words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
