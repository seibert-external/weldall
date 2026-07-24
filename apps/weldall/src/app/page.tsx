import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth/auth";
import { requireAdminUser } from "@/server/admin/service";

export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user.id) redirect("/login");
  try {
    await requireAdminUser(session.user.id);
  } catch {
    redirect("/access-denied");
  }
  redirect("/scopes");
}
