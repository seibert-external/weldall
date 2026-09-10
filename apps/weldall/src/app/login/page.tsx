import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/Stack";
import { installationCompleted, publicLoginProviders } from "@/server/auth/login-service";
import { redirect } from "next/navigation";
import { AppearanceSequence } from "../_components/appearance-sequence";
import { LoginOptions } from "./login-options";

export const dynamic = "force-dynamic";

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  if (!(await installationCompleted())) redirect(query.loginError ? "/setup?failed=1" : "/setup");
  const loginProviders = await publicLoginProviders();
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
              <LoginOptions providers={loginProviders} />
            </div>
          </VStack>
        </AppearanceSequence>
      </main>
    </div>
  );
}
