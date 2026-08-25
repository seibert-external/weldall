import { lucideIconNames } from "@/server/skills/appearance-icons";
import { SkillDetail } from "../skill-detail";

export default async function SkillPage({ params }: { params: Promise<{ skillId: string }> }) {
  const { skillId } = await params;
  return <SkillDetail iconOptions={lucideIconNames} skillId={skillId} />;
}
