"use client";

import { useEffect } from "react";

export function TestResultNotifier({
  mode,
  testId,
  passed,
}: {
  mode: "setup-test" | "provider-test";
  testId: string;
  passed: boolean;
}) {
  useEffect(() => {
    window.opener?.postMessage({ type: `weldall-${mode}`, testId, passed }, window.location.origin);
  }, [mode, passed, testId]);

  return null;
}
