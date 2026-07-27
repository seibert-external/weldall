import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/Stack";
import { ConsentOptions } from "./consent-options";

const cliScopes = [
  ["openid", "Confirm your Weldall identity"],
  ["profile", "Read your name"],
  ["email", "Read your verified email address"],
  ["offline_access", "Stay signed in using a rotating refresh token"],
  ["weldall:scopes", "Read your assigned scopes and resource registry"],
] as const;

export default function Consent() {
  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="consent-heading">
        <VStack gap={4} hAlign="stretch">
          <VStack gap={1} hAlign="stretch">
            <Heading level={1} id="consent-heading">
              Allow Weldall CLI?
            </Heading>
            <p>
              <strong>Weldall CLI</strong> is requesting access for this login.
            </p>
          </VStack>
          <ul>
            {cliScopes.map(([scope, description]) => (
              <li key={scope}>
                <code>{scope}</code> — {description}
              </li>
            ))}
          </ul>
          <p>Only approve if you started this login from the Weldall CLI on this device.</p>
          <ConsentOptions />
        </VStack>
      </section>
    </main>
  );
}
