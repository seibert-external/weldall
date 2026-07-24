import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import { SignOutButton } from "./sign-out-button";

export default function AccessDeniedPage() {
  return (
    <div className="login-shell">
      <main className="login-panel">
        <VStack gap={4} hAlign="stretch">
          <Heading level={1}>Administrator access required</Heading>
          <Text color="secondary">
            Your verified email does not have the weldall:administer scope. Ask an administrator to
            add an assignment, or run the one-time bootstrap command when setting up Weldall.
          </Text>
          <SignOutButton />
        </VStack>
      </main>
    </div>
  );
}
