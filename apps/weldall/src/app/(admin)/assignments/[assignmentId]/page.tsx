import { AssignmentDetail } from "../assignment-detail";

export default async function AssignmentPage({
  params,
}: {
  params: Promise<{ assignmentId: string }>;
}) {
  const { assignmentId } = await params;
  return <AssignmentDetail assignmentId={assignmentId} />;
}
