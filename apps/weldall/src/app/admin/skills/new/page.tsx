import { lucideIconNames } from "@/server/skills/appearance-icons";
import { SkillDetail } from "../skill-detail";

export default function NewSkillPage() {
  return <SkillDetail iconOptions={lucideIconNames} skillId={null} />;
}
