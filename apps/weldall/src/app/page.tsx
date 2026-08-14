import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/Stack";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { AppearanceSequence } from "./_components/appearance-sequence";
import { InstallPrompt } from "./install-prompt";

export default function Home() {
  return (
    <div className="login-shell welcome-shell">
      <main className="login-panel welcome-panel">
        <AppearanceSequence>
          <VStack gap={8} hAlign="stretch">
            <div className="welcome-brand-lockup" aria-label="Weldall by Seibert" data-appear>
              <img
                src="/assets/images/weldall.png"
                alt="Weldall"
                width={364}
                height={101}
                className="welcome-brand-logo welcome-brand-weldall"
              />
              <span className="welcome-brand-x" aria-hidden="true">
                ×
              </span>
              <img
                src="https://seibert.group/dk/wp-content/uploads/2024/06/seibert_logo.svg"
                alt="Seibert"
                width={958}
                height={245}
                className="welcome-brand-logo welcome-brand-seibert"
              />
            </div>
            <VStack className="welcome-content" gap={4} hAlign="stretch">
              <div data-appear>
                <Heading className="welcome-heading" level={1}>
                  Weldall allows you to access your company’s services through your agent. Copy the
                  prompt below and send it to your agent to get started.
                </Heading>
              </div>
              <div data-appear>
                <InstallPrompt host={WELDALL_ISSUER} />
              </div>
            </VStack>
            <a className="welcome-admin-link" href="/login" data-appear>
              I’m an admin, let me in
            </a>
          </VStack>
        </AppearanceSequence>
      </main>
    </div>
  );
}
