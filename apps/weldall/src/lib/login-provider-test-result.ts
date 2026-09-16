export type ActiveProviderTest = { popup: Window; testId: string; revision: number };
/** Only the active popup may report the result for the unchanged form revision. */
export function providerTestResult(
  event: MessageEvent,
  active: ActiveProviderTest | null,
  origin: string,
  revision: number,
  type: "weldall-provider-test" | "weldall-setup-test" = "weldall-provider-test",
): boolean | undefined {
  if (
    !active ||
    event.origin !== origin ||
    event.source !== active.popup ||
    event.data?.type !== type ||
    event.data.testId !== active.testId ||
    active.revision !== revision ||
    typeof event.data.passed !== "boolean"
  )
    return undefined;
  return event.data.passed;
}
