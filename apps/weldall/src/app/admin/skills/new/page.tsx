import { lucideIconNames, lucideIconTags } from "@/server/skills/appearance-icons";
import { brandIconOptions } from "@/server/skills/brand-icons";
import { SkillDetail } from "../skill-detail";

export default function NewSkillPage() {
  return (
    <SkillDetail
      brandOptions={brandIconOptions}
      iconOptions={lucideIconNames.filter((name) => name in lucideIconTags)}
      iconTags={lucideIconTags}
      skillId={null}
    />
  );
}
