import { SkillDetail } from "../skill-detail";

export default async function SkillPage({ params }: { params: Promise<{ skillId: string }> }) {
  const { skillId } = await params;
  return <SkillDetail skillId={skillId} />;
}
