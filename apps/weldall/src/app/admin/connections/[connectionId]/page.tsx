import { ConnectionDetail } from "../connection-detail";

export default async function ConnectionPage({
  params,
}: {
  params: Promise<{ connectionId: string }>;
}) {
  const { connectionId } = await params;
  return <ConnectionDetail connectionId={connectionId} />;
}
