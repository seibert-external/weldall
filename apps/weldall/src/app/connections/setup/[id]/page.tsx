import { VStack } from "@astryxdesign/core/Stack";
import { SetupForm } from "./setup-form";
export const metadata = {
  title: "Connect an account",
  referrer: "no-referrer" as const,
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
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
          <SetupForm id={(await params).id} />
        </VStack>
      </main>
    </div>
  );
}
