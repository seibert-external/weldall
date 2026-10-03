import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CompletionPanel } from "@/app/_components/completion-panel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Connection result | Weldall",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const resultContent = {
  success: {
    title: "Connection ready",
    message: "Your account is connected. Return to the CLI to see the granted permissions.",
    icon: "success",
    color: "success",
  },
  cancelled: {
    title: "Authorization cancelled",
    message: "No connection was created. Return to the CLI when you are ready to try again.",
    icon: "warning",
    color: "warning",
  },
  failed: {
    title: "Authorization failed",
    message: "Return to the CLI to check the status and any required cleanup before trying again.",
    icon: "error",
    color: "error",
  },
} as const;

export default async function ConnectionResultPage({
  params,
}: {
  params: Promise<{ outcome: string }>;
}) {
  const content = resultContent[(await params).outcome as keyof typeof resultContent];
  if (!content) notFound();

  return (
    <CompletionPanel
      title={content.title}
      message={`${content.message} You can close this tab after returning to the CLI.`}
      icon={content.icon}
      color={content.color}
    />
  );
}
