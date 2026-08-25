import { ResourceDetail } from "../resource-detail";

export default async function ResourcePage({
  params,
}: {
  params: Promise<{ resourceId: string }>;
}) {
  const { resourceId } = await params;
  return <ResourceDetail resourceId={resourceId} />;
}
