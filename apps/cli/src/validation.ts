import {
  ArgsValidationErrorKeys,
  isArgsValidationError,
  isCommandNotFoundError,
  type CommandContext,
} from "gunshi";
import { renderValidationErrors } from "gunshi/renderer";

const distance = (left: string, right: string) => {
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = Array.from({ length: right.length + 1 }, () => 0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++)
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    [previous, current] = [current, previous];
  }
  return previous[right.length]!;
};

const closest = (input: string, candidates: readonly string[]) =>
  candidates
    .map((candidate) => ({ candidate, distance: distance(input, candidate) }))
    .filter((item) => item.distance <= 2)
    .sort((left, right) => left.distance - right.distance)[0]?.candidate;

const suggestion = (error: unknown): string | undefined => {
  if (isCommandNotFoundError(error)) return closest(error.commandName, error.candidates);
  if (!isArgsValidationError(error) || error.code !== ArgsValidationErrorKeys.unknownOption)
    return undefined;
  const values = error.values;
  if (typeof values.name !== "string" || !Array.isArray(values.candidates)) return undefined;
  const candidates = values.candidates.filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.startsWith("--"),
  );
  const normalized = values.name.startsWith("--") ? values.name.slice(2) : values.name;
  const match = closest(
    normalized,
    candidates.map((candidate) => candidate.slice(2)),
  );
  return match ? `--${match}` : undefined;
};

export async function renderFriendlyValidation(
  context: Readonly<CommandContext>,
  error: AggregateError,
) {
  const message = await renderValidationErrors(context, error);
  const match = error.errors.map(suggestion).find((value) => value !== undefined);
  return match ? `${message}\nDid you mean ${match}?` : message;
}
