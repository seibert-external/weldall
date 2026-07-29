import { GroupAssignmentDetail } from "../group-assignment-detail";

export default async function GroupAssignmentPage({
  params,
}: {
  params: Promise<{ assignmentId: string }>;
}) {
  const { assignmentId } = await params;
  return <GroupAssignmentDetail assignmentId={assignmentId} />;
}
