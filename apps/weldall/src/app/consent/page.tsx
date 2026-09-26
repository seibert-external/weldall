import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/Stack";
import { ConsentOptions } from "./consent-options";

export default function Consent() {
  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="consent-heading">
        <VStack gap={4} hAlign="stretch">
          <img
            src="/assets/images/weldall.png"
            alt="Weldall"
            width={182}
            height={51}
            className="login-auth-logo"
          />
          <p className="mt-4">
            Login to Weldall CLI: Only approve if you started this login on this device.
          </p>
          <ConsentOptions />
        </VStack>
      </section>
    </main>
  );
}
