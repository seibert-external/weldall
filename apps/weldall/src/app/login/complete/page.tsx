import type { Metadata } from "next";
import { CompletionPanel } from "@/app/_components/completion-panel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Login complete | Weldall",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function LoginCompletePage() {
  return (
    <CompletionPanel
      title="Weldall login complete"
      message="You may close this window."
      icon="success"
      color="success"
    />
  );
}
