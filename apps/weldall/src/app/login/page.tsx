import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/Stack";
import { resolveLoginProviders } from "@/server/auth/providers";
import LoginGlyphCanvas from "./login-glyph-canvas";
import { LoginOptions } from "./login-options";

export default function Login() {
  const loginProviders = resolveLoginProviders();
  return (
    <div className="login-shell" id="login-hero">
      <LoginGlyphCanvas />
      <header className="login-header">
        <img
          src="/assets/images/weldall.png"
          alt="Weldall"
          width={144}
          height={40}
          className="login-logo"
        />
      </header>
      <main className="login-panel">
        <VStack gap={5} hAlign="stretch">
          <VStack gap={1} hAlign="stretch">
            <Heading level={1}>Sign in to Weldall</Heading>
          </VStack>
          <LoginOptions
            google={Boolean(loginProviders.google)}
            dev={Boolean(loginProviders.devOidc)}
          />
        </VStack>
      </main>
    </div>
  );
}
