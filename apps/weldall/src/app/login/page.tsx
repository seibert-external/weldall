import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import { resolveLoginProviders } from "@/server/auth/providers";
import { LoginOptions } from "./login-options";

export default function Login() {
  const loginProviders = resolveLoginProviders();
  return (
    <div className="login-shell">
      <main className="login-panel">
        <VStack gap={5} hAlign="stretch">
          <VStack gap={1} hAlign="stretch">
            <Heading level={1}>Sign in to Weldall</Heading>
            <Text color="secondary">
              Manage scopes and email assignments with your verified identity.
            </Text>
          </VStack>
          <LoginOptions
            google={Boolean(loginProviders.google)}
            dev={Boolean(loginProviders.devOidc)}
          />
          {loginProviders.devOidc ? (
            <Text color="secondary" type="supporting">
              Development login is enabled. Do not use real identities.
            </Text>
          ) : null}
        </VStack>
      </main>
    </div>
  );
}
