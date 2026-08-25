import { UserDetail } from "../user-detail";

export default async function UserPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  return <UserDetail userId={userId} />;
}
