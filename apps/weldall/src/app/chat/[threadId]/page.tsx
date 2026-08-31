import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getChatThreadMetadata } from "@/server/ai/chat-threads";
import { auth } from "@/server/auth/auth";

export default async function ChatThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user.id || !session.user.email || !session.user.emailVerified) redirect("/login");

  const { threadId } = await params;
  if (!(await getChatThreadMetadata(session.user.id, threadId))) notFound();
  return null;
}
