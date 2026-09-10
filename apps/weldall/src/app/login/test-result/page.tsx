import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { TestResultNotifier } from "./test-result-notifier";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "OIDC login test | Weldall",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const testResultSchema = z
  .object({
    mode: z.enum(["setup-test", "provider-test"]),
    testId: z.string().uuid(),
    passed: z.enum(["true", "false"]).transform((value) => value === "true"),
  })
  .strict();

export default async function LoginTestResultPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const result = testResultSchema.safeParse(await searchParams);
  if (!result.success) notFound();

  const { mode, testId, passed } = result.data;
  const message = passed
    ? mode === "setup-test"
      ? "The test login passed. Nothing was saved; return to setup to complete installation with a separate verified login."
      : "The test login passed. Return to the provider form and save explicitly."
    : "The test login failed. Return to the form, review the provider settings, and try again.";

  return (
    <div className="login-shell">
      <main className="login-panel login-auth-panel">
        <VStack gap={5} hAlign="stretch">
          <img
            src="/assets/images/weldall.png"
            alt="Weldall"
            width={182}
            height={51}
            className="login-auth-logo"
          />
          <VStack gap={2} hAlign="stretch">
            <Heading level={1}>{passed ? "Login test passed" : "Login test failed"}</Heading>
            <Text color="secondary">{message}</Text>
          </VStack>
        </VStack>
        <TestResultNotifier mode={mode} testId={testId} passed={passed} />
      </main>
    </div>
  );
}
