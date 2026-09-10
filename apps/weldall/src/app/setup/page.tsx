import { Banner } from "@astryxdesign/core/Banner";
import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { redirect } from "next/navigation";
import { callbackUrl, firstProviderId, installationCompleted } from "@/server/auth/login-service";
import { setupConfigurationIssues } from "@/server/auth/oidc-credentials";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";
export default async function Setup() {
  if (await installationCompleted()) redirect("/login");
  const issues = setupConfigurationIssues();
  return (
    <div className="login-shell">
      <main className="login-panel setup-panel">
        <VStack gap={5} hAlign="stretch">
          <img
            src="/assets/images/weldall.png"
            alt="Weldall"
            width={182}
            height={51}
            className="login-auth-logo"
          />
          <Heading level={1}>Set up Weldall</Heading>
          {issues.length ? (
            <>
              <Banner
                container="card"
                status="error"
                title="Setup requires server configuration"
                description={`Missing or invalid: ${issues.join(", ")}. Ask the operator to configure these environment variables and restart Weldall, then reload this page.`}
              />
              <Text color="secondary">
                WELDALL_SETUP_TOKEN must be a base64url token generated from at least 32 random
                bytes. WELDALL_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key,
                shared with group-provider and chat credentials. Keep the encryption key stable;
                never replace an existing key to retry setup.
              </Text>
            </>
          ) : (
            <>
              <Text color="secondary">
                Configure your first identity provider. Test login is optional and saves nothing.
                Complete installation starts a separate verified login matching the nominated
                administrator email, whether or not you tested first.
              </Text>
              <SetupForm callbackUrl={callbackUrl(firstProviderId())} />
            </>
          )}
        </VStack>
      </main>
    </div>
  );
}
