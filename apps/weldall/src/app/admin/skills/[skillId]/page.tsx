import { lucideIconNames, lucideIconTags } from "@/server/skills/appearance-icons";
import { brandIconOptions } from "@/server/skills/brand-icons";
import { SkillDetail } from "../skill-detail";

export default async function SkillPage({ params }: { params: Promise<{ skillId: string }> }) {
  const { skillId } = await params;
  return (
    <SkillDetail
      brandOptions={brandIconOptions}
      iconOptions={lucideIconNames.filter((name) => name in lucideIconTags)}
      iconTags={lucideIconTags}
      skillId={skillId}
    />
  );
}
