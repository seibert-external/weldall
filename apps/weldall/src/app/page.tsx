import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "../server/auth/auth";
import { installationCompleted } from "../server/auth/login-service";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await installationCompleted())) redirect("/setup");
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user.email) redirect("/login");
  redirect("/skills");
}
