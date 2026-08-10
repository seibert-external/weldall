import { WorkloadDetail } from "../workload-detail";

export default async function WorkloadPage({
  params,
}: {
  params: Promise<{ workloadId: string }>;
}) {
  const { workloadId } = await params;
  return <WorkloadDetail workloadId={workloadId} />;
}
