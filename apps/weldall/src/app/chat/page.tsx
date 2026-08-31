import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Assistant } from "@/app/assistant";
import { getChatModelStatus } from "@/server/ai/configuration";
import { auth } from "@/server/auth/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Chat | Weldall",
  description: "Chat with Weldall.",
};

export default async function ChatPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user.email || !session.user.emailVerified) redirect("/login");

  const chat = await getChatModelStatus();
  if (!chat.enabled || !chat.configured) {
    return (
      <main className="chat-page grid min-h-dvh place-items-center px-6">
        <section
          aria-labelledby="chat-unavailable-title"
          className="w-full max-w-lg rounded-2xl border border-border bg-card p-8 text-center shadow-sm"
        >
          <div
            aria-hidden="true"
            className="mx-auto mb-5 grid size-12 place-items-center rounded-full bg-muted text-2xl"
          >
            💬
          </div>
          <h1 id="chat-unavailable-title" className="text-2xl font-semibold tracking-tight">
            Chat isn&apos;t available right now
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {chat.enabled
              ? "An administrator needs to finish configuring the AI provider."
              : "Chat has been disabled by an administrator."}
          </p>
        </section>
      </main>
    );
  }

  return <Assistant />;
}
