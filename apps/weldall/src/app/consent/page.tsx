import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/Stack";
import { ConsentOptions } from "./consent-options";

export default function Consent() {
  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="consent-heading">
        <VStack gap={4} hAlign="stretch">
          <VStack gap={1} hAlign="stretch">
            <Heading level={1} id="consent-heading">
              Login to Weldall CLI
            </Heading>
          </VStack>
          <p>Only approve if you started this login from the Weldall CLI on this device.</p>
          <ConsentOptions />
        </VStack>
      </section>
    </main>
  );
}
