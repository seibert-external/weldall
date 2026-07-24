import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth/auth";
import { requireAdminUser } from "@/server/admin/service";
import { AdminFrame } from "../_components/admin-frame";
import { AdminPageChrome } from "../_components/herocrumbs";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user.id) redirect("/login");
  try {
    await requireAdminUser(session.user.id);
  } catch {
    redirect("/access-denied");
  }

  return (
    <AdminFrame>
      <AdminPageChrome>{children}</AdminPageChrome>
    </AdminFrame>
  );
}
