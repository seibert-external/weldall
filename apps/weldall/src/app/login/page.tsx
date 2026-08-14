import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/Stack";
import { resolveLoginProviders } from "@/server/auth/providers";
import { AppearanceSequence } from "../_components/appearance-sequence";
import { LoginOptions } from "./login-options";

export default function Login() {
  const loginProviders = resolveLoginProviders();
  return (
    <div className="login-shell">
      <main className="login-panel login-auth-panel">
        <AppearanceSequence>
          <VStack gap={5} hAlign="stretch">
            <div data-appear>
              <img
                src="/assets/images/weldall.png"
                alt="Weldall"
                width={182}
                height={51}
                className="login-auth-logo"
              />
            </div>
            <div data-appear>
              <Heading level={1}>Sign in to Weldall</Heading>
            </div>
            <div data-appear>
              <LoginOptions
                google={Boolean(loginProviders.google)}
                dev={Boolean(loginProviders.devOidc)}
              />
            </div>
          </VStack>
        </AppearanceSequence>
      </main>
    </div>
  );
}
