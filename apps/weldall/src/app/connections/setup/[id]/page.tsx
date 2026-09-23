import { SetupForm } from "./setup-form";
export const metadata = {
  title: "Connect an account",
  referrer: "no-referrer" as const,
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="mx-auto max-w-2xl p-6">
      <SetupForm id={(await params).id} />
    </main>
  );
}
